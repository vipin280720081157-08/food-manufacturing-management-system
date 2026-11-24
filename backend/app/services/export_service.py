"""
Authorized report exports for the Food Manufacturing Management System.

Supported formats:
- CSV (UTF-8 with BOM)
- Excel (.xlsx, Office Open XML)
- PDF (simple paginated tabular report)

Exports operate on report data supplied by the reporting layer.
They do not query or modify business records, calculate report
figures, or commit database transactions.

The reporting layer must supply complete, already-filtered report
rows. Exporting a paginated API response exports only those rows,
not records omitted by pagination.

Only Factory Admin, Accountant/Auditor, and Owner may export reports.
"""

from __future__ import annotations

import csv
import io
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import HTTPException, status
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.models.user import User


EXPORT_ROLES = frozenset(
    {
        "Factory Admin",
        "Accountant/Auditor",
        "Owner",
    }
)

SUPPORTED_FORMATS = frozenset({"csv", "xlsx", "pdf"})

MAX_EXPORT_ROWS = 100_000
MAX_EXPORT_COLUMNS = 100
MAX_CELL_LENGTH = 32_767
MAX_PDF_ROWS = 20_000

CSV_MEDIA_TYPE = "text/csv; charset=utf-8"
XLSX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument."
    "spreadsheetml.sheet"
)
PDF_MEDIA_TYPE = "application/pdf"

_XML_ILLEGAL = re.compile(
    r"[\x00-\x08\x0b\x0c\x0e-\x1f]"
)

_FILENAME_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]+")
_SHEET_UNSAFE = re.compile(r"[\[\]:*?/\\]")

_PDF_PAGE_WIDTH = 595
_PDF_PAGE_HEIGHT = 842
_PDF_MARGIN = 40
_PDF_ROW_HEIGHT = 15
_PDF_FONT_SIZE = 8
_PDF_HEADER_FONT_SIZE = 14


def _error(code: int, detail: str) -> HTTPException:
    return HTTPException(status_code=code, detail=detail)


def _require_export_permission(
    db: Session,
    actor_id: UUID,
) -> User:
    """Authorize report export without changing database state."""

    user = db.get(User, actor_id)

    if user is None or not user.is_active:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "An active user account is required.",
        )

    role = user.primary_role

    if role is None or role.role_name not in EXPORT_ROLES:
        raise _error(
            status.HTTP_403_FORBIDDEN,
            "Report export is not permitted for this role.",
        )

    return user


def _safe_filename(value: str) -> str:
    """Normalize a download filename without permitting path traversal."""

    if not isinstance(value, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Export filename must be a string.",
        )

    name = _FILENAME_UNSAFE.sub(
        "_",
        value.strip(),
    ).strip("._")

    if not name:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Export filename cannot be empty.",
        )

    return name[:100]


def _safe_sheet_name(value: str) -> str:
    """Return a valid Excel worksheet name."""

    name = _SHEET_UNSAFE.sub(
        "_",
        value.strip(),
    ).strip("'")

    return (name or "Report")[:31]


def _stringify(value: object) -> str:
    """Convert report values to deterministic display strings."""

    if value is None:
        return ""

    if isinstance(value, bool):
        return "Yes" if value else "No"

    if isinstance(value, Decimal):
        if not value.is_finite():
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Report contains a non-finite decimal value.",
            )

        return format(value, "f")

    if isinstance(value, datetime):
        return value.isoformat()

    if isinstance(value, date):
        return value.isoformat()

    if isinstance(value, UUID):
        return str(value)

    if isinstance(value, float):
        if not math.isfinite(value):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Report contains a non-finite numeric value.",
            )

        return str(value)

    if isinstance(value, (int, str)):
        return str(value)

    if isinstance(value, bytes):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Binary values cannot be exported as report cells.",
        )

    if isinstance(value, Mapping):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Nested report objects must be flattened before export.",
        )

    if isinstance(value, (list, tuple, set)):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Nested report collections must be flattened before export.",
        )

    raise _error(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        f"Unsupported report cell type: {type(value).__name__}.",
    )


def _safe_cell_text(value: object) -> str:
    """Validate a cell and remove invalid XML control characters."""

    text = _XML_ILLEGAL.sub("", _stringify(value))

    if len(text) > MAX_CELL_LENGTH:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Report cell exceeds the maximum supported length.",
        )

    return text


def _csv_safe(value: object) -> str:
    """
    Protect CSV consumers against spreadsheet formula injection.

    Values beginning with formula-triggering characters, including
    those following whitespace or control characters, are prefixed
    with an apostrophe.
    """

    text = _safe_cell_text(value)

    if text.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + text

    if text.startswith(("\t", "\r", "\n")):
        return "'" + text

    return text


def _validate_columns(
    columns: Sequence[str],
) -> list[str]:
    if isinstance(columns, (str, bytes)) or not isinstance(
        columns,
        Sequence,
    ):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Report columns must be an ordered sequence.",
        )

    normalized: list[str] = []

    for column in columns:
        if not isinstance(column, str):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Report column names must be strings.",
            )

        name = column.strip()

        if not name:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Report column names cannot be blank.",
            )

        normalized.append(name)

    if not normalized:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "At least one report column is required.",
        )

    if len(normalized) > MAX_EXPORT_COLUMNS:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Report contains too many columns.",
        )

    if len(set(normalized)) != len(normalized):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Duplicate report column names are not permitted.",
        )

    for name in normalized:
        _safe_cell_text(name)

    return normalized


def _normalize_rows(
    *,
    columns: Sequence[str],
    rows: Iterable[Mapping[str, object]],
) -> list[list[object]]:
    """
    Materialize report rows in the declared column order.

    Every row must provide all declared columns. Additional mapping
    keys are ignored because only explicitly declared columns are
    authorized for export.
    """

    normalized: list[list[object]] = []

    for row in rows:
        if len(normalized) >= MAX_EXPORT_ROWS:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Report exceeds the maximum export row count.",
            )

        if not isinstance(row, Mapping):
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Each report row must be a mapping.",
            )

        missing = [
            column
            for column in columns
            if column not in row
        ]

        if missing:
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Report row is missing required columns: "
                + ", ".join(missing),
            )

        values = [row[column] for column in columns]

        for value in values:
            _safe_cell_text(value)

        normalized.append(values)

    return normalized


def _column_letter(index: int) -> str:
    """Convert a zero-based column index to an Excel column name."""

    index += 1
    result = ""

    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result

    return result


def _xlsx_cell(
    coordinate: str,
    value: object,
    *,
    header: bool = False,
) -> str:
    """Serialize one Excel cell using an appropriate OOXML type."""

    style = ' s="1"' if header else ""

    if isinstance(value, bool):
        return (
            f'<c r="{coordinate}" t="b"{style}>'
            f"<v>{1 if value else 0}</v></c>"
        )

    if isinstance(value, (int, Decimal)) and not isinstance(
        value,
        bool,
    ):
        number = _stringify(value)

        if isinstance(value, Decimal) and not value.is_finite():
            raise _error(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Excel cannot export non-finite decimals.",
            )

        return (
            f'<c r="{coordinate}" t="n"{style}>'
            f"<v>{xml_escape(number)}</v></c>"
        )

    text = _safe_cell_text(value)

    # Explicit string cells prevent Excel from evaluating formulas
    # supplied through user-entered report fields.
    escaped = xml_escape(
        text,
        {'"': "&quot;"},
    )

    return (
        f'<c r="{coordinate}" t="inlineStr"{style}>'
        f'<is><t xml:space="preserve">{escaped}</t></is></c>'
    )


def _xlsx_sheet_xml(
    columns: Sequence[str],
    rows: Sequence[Sequence[object]],
) -> bytes:
    output = io.StringIO()

    output.write(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/'
        'spreadsheetml/2006/main">'
    )

    output.write(
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" '
        'activePane="bottomLeft" state="frozen"/>'
        '</sheetView></sheetViews>'
    )

    output.write("<sheetData>")

    output.write('<row r="1">')

    for index, name in enumerate(columns):
        output.write(
            _xlsx_cell(
                f"{_column_letter(index)}1",
                name,
                header=True,
            )
        )

    output.write("</row>")

    for row_number, values in enumerate(rows, start=2):
        output.write(f'<row r="{row_number}">')

        for index, value in enumerate(values):
            output.write(
                _xlsx_cell(
                    f"{_column_letter(index)}{row_number}",
                    value,
                )
            )

        output.write("</row>")

    output.write("</sheetData>")

    last_column = _column_letter(len(columns) - 1)
    last_row = len(rows) + 1

    output.write(
        f'<autoFilter ref="A1:{last_column}{last_row}"/>'
        "</worksheet>"
    )

    return output.getvalue().encode("utf-8")


def _xlsx_styles_xml() -> bytes:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/'
        'spreadsheetml/2006/main">'
        '<fonts count="2">'
        '<font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/></font>'
        '</fonts>'
        '<fills count="2">'
        '<fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '</fills>'
        '<borders count="1"><border/></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" '
        'fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2">'
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" '
        'xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" '
        'xfId="0" applyFont="1"/>'
        '</cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" '
        'xfId="0" builtinId="0"/></cellStyles>'
        '</styleSheet>'
    ).encode("utf-8")


def generate_csv(
    *,
    columns: Sequence[str],
    rows: Iterable[Mapping[str, object]],
) -> bytes:
    """
    Generate an Excel-compatible UTF-8 CSV export.

    The UTF-8 BOM improves compatibility with Microsoft Excel.
    """

    headers = _validate_columns(columns)
    data = _normalize_rows(
        columns=headers,
        rows=rows,
    )

    output = io.StringIO(newline="")
    writer = csv.writer(
        output,
        dialect="excel",
        lineterminator="\r\n",
    )

    writer.writerow(
        [_csv_safe(header) for header in headers]
    )

    for row in data:
        writer.writerow(
            [_csv_safe(value) for value in row]
        )

    return output.getvalue().encode("utf-8-sig")


def generate_excel(
    *,
    columns: Sequence[str],
    rows: Iterable[Mapping[str, object]],
    sheet_name: str = "Report",
) -> bytes:
    """
    Generate a standards-compliant single-sheet .xlsx workbook.

    Uses Python's standard-library ZIP and XML facilities, avoiding
    an undeclared runtime dependency on openpyxl or xlsxwriter.
    """

    headers = _validate_columns(columns)
    data = _normalize_rows(
        columns=headers,
        rows=rows,
    )

    if not isinstance(sheet_name, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Worksheet name must be a string.",
        )

    safe_sheet = _safe_sheet_name(sheet_name)

    sheet_xml = _xlsx_sheet_xml(
        headers,
        data,
    )

    workbook_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/'
        'spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/'
        'officeDocument/2006/relationships">'
        '<sheets>'
        f'<sheet name="{xml_escape(safe_sheet, {"\"": "&quot;"})}" '
        'sheetId="1" r:id="rId1"/>'
        '</sheets></workbook>'
    ).encode("utf-8")

    workbook_relationships = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/'
        'package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/'
        'officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" '
        'Type="http://schemas.openxmlformats.org/'
        'officeDocument/2006/relationships/styles" '
        'Target="styles.xml"/>'
        '</Relationships>'
    ).encode("utf-8")

    root_relationships = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/'
        'package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/'
        'officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        '</Relationships>'
    ).encode("utf-8")

    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/'
        'package/2006/content-types">'
        '<Default Extension="rels" '
        'ContentType="application/vnd.openxmlformats-package.'
        'relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.'
        'spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.'
        'spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.'
        'spreadsheetml.styles+xml"/>'
        '</Types>'
    ).encode("utf-8")

    buffer = io.BytesIO()

    with ZipFile(
        buffer,
        mode="w",
        compression=ZIP_DEFLATED,
    ) as workbook:
        workbook.writestr(
            "[Content_Types].xml",
            content_types,
        )
        workbook.writestr(
            "_rels/.rels",
            root_relationships,
        )
        workbook.writestr(
            "xl/workbook.xml",
            workbook_xml,
        )
        workbook.writestr(
            "xl/_rels/workbook.xml.rels",
            workbook_relationships,
        )
        workbook.writestr(
            "xl/worksheets/sheet1.xml",
            sheet_xml,
        )
        workbook.writestr(
            "xl/styles.xml",
            _xlsx_styles_xml(),
        )

    return buffer.getvalue()


def _pdf_escape(value: str) -> str:
    """Escape a text string for a PDF literal-string operand."""

    return (
        value.replace("\\", "\\\\")
        .replace("(", "\\(")
        .replace(")", "\\)")
        .replace("\r", " ")
        .replace("\n", " ")
    )


def _pdf_ascii(value: object) -> str:
    """
    Convert a cell to the standard PDF Helvetica encoding.

    Non-Latin characters are replaced rather than emitting
    malformed glyph encodings in a font-free PDF.
    """

    text = _safe_cell_text(value)

    return text.encode(
        "latin-1",
        errors="replace",
    ).decode("latin-1")


def _pdf_text_command(
    *,
    x: float,
    y: float,
    text: str,
    font_size: int = _PDF_FONT_SIZE,
    bold: bool = False,
) -> str:
    font = "F2" if bold else "F1"

    return (
        f"BT /{font} {font_size} Tf "
        f"1 0 0 1 {x:.2f} {y:.2f} Tm "
        f"({_pdf_escape(text)}) Tj ET\n"
    )


def _pdf_table_page(
    *,
    title: str,
    headers: Sequence[str],
    rows: Sequence[Sequence[object]],
    page_number: int,
    page_count: int,
) -> bytes:
    """Create one PDF page content stream."""

    commands: list[str] = []

    commands.append(
        _pdf_text_command(
            x=_PDF_MARGIN,
            y=_PDF_PAGE_HEIGHT - _PDF_MARGIN,
            text=_pdf_ascii(title)[:100],
            font_size=_PDF_HEADER_FONT_SIZE,
            bold=True,
        )
    )

    column_count = len(headers)
    usable_width = _PDF_PAGE_WIDTH - 2 * _PDF_MARGIN
    column_width = usable_width / column_count

    # Standard A4 portrait layout. Wider reports use a shortened
    # representation in PDF; CSV and Excel retain full cell values.
    maximum_characters = max(
        3,
        int(column_width / 4.4) - 1,
    )

    def shortened(value: object) -> str:
        text = _pdf_ascii(value)

        if len(text) <= maximum_characters:
            return text

        return text[: maximum_characters - 1] + "~"

    y = _PDF_PAGE_HEIGHT - _PDF_MARGIN - 35

    commands.append(
        f"0.92 0.92 0.92 rg "
        f"{_PDF_MARGIN} {y - 5:.2f} "
        f"{usable_width:.2f} 16 re f\n"
        "0 0 0 rg\n"
    )

    for index, header in enumerate(headers):
        commands.append(
            _pdf_text_command(
                x=_PDF_MARGIN + index * column_width + 2,
                y=y,
                text=shortened(header),
                bold=True,
            )
        )

    y -= _PDF_ROW_HEIGHT + 5

    for row_index, row in enumerate(rows):
        if row_index % 2 == 1:
            commands.append(
                f"0.97 0.97 0.97 rg "
                f"{_PDF_MARGIN} {y - 4:.2f} "
                f"{usable_width:.2f} 14 re f\n"
                "0 0 0 rg\n"
            )

        for index, value in enumerate(row):
            commands.append(
                _pdf_text_command(
                    x=_PDF_MARGIN + index * column_width + 2,
                    y=y,
                    text=shortened(value),
                )
            )

        y -= _PDF_ROW_HEIGHT

    commands.append(
        _pdf_text_command(
            x=_PDF_MARGIN,
            y=25,
            text=f"Page {page_number} of {page_count}",
        )
    )

    return "".join(commands).encode("latin-1")


def _assemble_pdf(
    content_streams: Sequence[bytes],
) -> bytes:
    """
    Assemble a valid PDF 1.4 document using standard fonts.

    Object offsets are calculated from the exact encoded byte
    positions, producing a conventional cross-reference table.
    """

    objects: list[bytes] = []

    def add_object(content: bytes) -> int:
        objects.append(content)
        return len(objects)

    catalog_id = add_object(b"")
    pages_id = add_object(b"")

    font_regular_id = add_object(
        b"<< /Type /Font /Subtype /Type1 "
        b"/BaseFont /Helvetica >>"
    )

    font_bold_id = add_object(
        b"<< /Type /Font /Subtype /Type1 "
        b"/BaseFont /Helvetica-Bold >>"
    )

    page_ids: list[int] = []

    for stream in content_streams:
        content_id = add_object(
            b"<< /Length "
            + str(len(stream)).encode("ascii")
            + b" >>\nstream\n"
            + stream
            + b"\nendstream"
        )

        page_id = add_object(
            (
                "<< /Type /Page "
                f"/Parent {pages_id} 0 R "
                f"/MediaBox [0 0 {_PDF_PAGE_WIDTH} "
                f"{_PDF_PAGE_HEIGHT}] "
                "/Resources << /Font << "
                f"/F1 {font_regular_id} 0 R "
                f"/F2 {font_bold_id} 0 R "
                ">> >> "
                f"/Contents {content_id} 0 R >>"
            ).encode("ascii")
        )

        page_ids.append(page_id)

    kids = " ".join(
        f"{page_id} 0 R"
        for page_id in page_ids
    )

    objects[catalog_id - 1] = (
        f"<< /Type /Catalog /Pages {pages_id} 0 R >>"
    ).encode("ascii")

    objects[pages_id - 1] = (
        f"<< /Type /Pages /Kids [{kids}] "
        f"/Count {len(page_ids)} >>"
    ).encode("ascii")

    output = io.BytesIO()
    output.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")

    offsets = [0]

    for object_number, content in enumerate(
        objects,
        start=1,
    ):
        offsets.append(output.tell())

        output.write(
            f"{object_number} 0 obj\n".encode("ascii")
        )
        output.write(content)
        output.write(b"\nendobj\n")

    cross_reference_offset = output.tell()

    output.write(
        f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    )
    output.write(b"0000000000 65535 f \n")

    for offset in offsets[1:]:
        output.write(
            f"{offset:010d} 00000 n \n".encode("ascii")
        )

    output.write(
        (
            "trailer\n"
            f"<< /Size {len(objects) + 1} "
            f"/Root {catalog_id} 0 R >>\n"
            "startxref\n"
            f"{cross_reference_offset}\n"
            "%%EOF\n"
        ).encode("ascii")
    )

    return output.getvalue()


def generate_pdf(
    *,
    title: str,
    columns: Sequence[str],
    rows: Iterable[Mapping[str, object]],
) -> bytes:
    """
    Generate a paginated, printable PDF table.

    PDF uses the built-in Helvetica font and an A4 portrait page.
    Full Unicode fidelity and complex report layouts are outside
    the scope of this standard-library implementation.
    """

    if not isinstance(title, str) or not title.strip():
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "PDF report title is required.",
        )

    headers = _validate_columns(columns)
    data = _normalize_rows(
        columns=headers,
        rows=rows,
    )

    if len(data) > MAX_PDF_ROWS:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "PDF export exceeds the supported row limit. "
            "Use CSV or Excel for larger reports.",
        )

    if len(headers) > 12:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "PDF export supports at most 12 columns. "
            "Use CSV or Excel for wider reports.",
        )

    rows_per_page = max(
        1,
        int(
            (
                _PDF_PAGE_HEIGHT
                - 2 * _PDF_MARGIN
                - 85
            )
            / _PDF_ROW_HEIGHT
        ),
    )

    pages = [
        data[index : index + rows_per_page]
        for index in range(0, len(data), rows_per_page)
    ]

    if not pages:
        pages = [[]]

    streams = [
        _pdf_table_page(
            title=title.strip(),
            headers=headers,
            rows=page_rows,
            page_number=index,
            page_count=len(pages),
        )
        for index, page_rows in enumerate(pages, start=1)
    ]

    return _assemble_pdf(streams)


def generate_report_export(
    *,
    export_format: str,
    columns: Sequence[str],
    rows: Iterable[Mapping[str, object]],
    title: str = "Report",
) -> tuple[bytes, str, str]:
    """
    Generate report bytes and return:

        (file_content, media_type, file_extension)

    The function is format-independent and does not perform
    authorization; use export_report for authenticated API calls.
    """

    if not isinstance(export_format, str):
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Export format must be a string.",
        )

    normalized_format = export_format.strip().lower()

    if normalized_format not in SUPPORTED_FORMATS:
        raise _error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Unsupported export format. "
            "Supported formats: csv, xlsx, pdf.",
        )

    if normalized_format == "csv":
        return (
            generate_csv(
                columns=columns,
                rows=rows,
            ),
            CSV_MEDIA_TYPE,
            "csv",
        )

    if normalized_format == "xlsx":
        return (
            generate_excel(
                columns=columns,
                rows=rows,
                sheet_name=title,
            ),
            XLSX_MEDIA_TYPE,
            "xlsx",
        )

    return (
        generate_pdf(
            title=title,
            columns=columns,
            rows=rows,
        ),
        PDF_MEDIA_TYPE,
        "pdf",
    )


def export_report(
    db: Session,
    *,
    actor_id: UUID,
    export_format: str,
    columns: Sequence[str],
    rows: Iterable[Mapping[str, object]],
    title: str = "Report",
    filename: str = "report",
) -> Response:
    """
    Produce an authenticated downloadable report response.

    Report data must already be restricted to the caller's
    authorized scope by the report service. This function enforces
    export-role authorization but does not replace report-level
    data-access checks.
    """

    _require_export_permission(
        db,
        actor_id,
    )

    content, media_type, extension = generate_report_export(
        export_format=export_format,
        columns=columns,
        rows=rows,
        title=title,
    )

    safe_name = _safe_filename(filename)
    download_name = f"{safe_name}.{extension}"

    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{download_name}"'
            ),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )