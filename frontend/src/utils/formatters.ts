
import type {
  DecimalString,
  ISODate,
  ISODateTime,
  Money,
  Percentage,
  Quantity,
  UnitOfMeasure,
} from "../types/business";

import {
  getUnitSymbol,
  normalizeDecimalString,
} from "./units";

/**
 * Presentation-only formatting utilities.
 *
 * Monetary values and quantities remain decimal strings across API
 * boundaries. Formatting does not perform authoritative business calculations.
 */

export const DEFAULT_LOCALE = "en-IN";
export const DEFAULT_CURRENCY = "INR";
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

export const EMPTY_VALUE = "—";

export interface DecimalFormatOptions {
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  useGrouping?: boolean;
}

export interface CurrencyFormatOptions {
  locale?: string;
  currency?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  showSymbol?: boolean;
}

export interface DateFormatOptions {
  locale?: string;
  timeZone?: string;
  day?: "numeric" | "2-digit";
  month?: "numeric" | "2-digit" | "short" | "long";
  year?: "numeric" | "2-digit";
}

export interface DateTimeFormatOptions extends DateFormatOptions {
  hour?: "numeric" | "2-digit";
  minute?: "numeric" | "2-digit";
  second?: "numeric" | "2-digit";
  hour12?: boolean;
}

const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

const ISO_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})$/;

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidDateObject(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

function parseISODate(value: ISODate): Date | null {
  const match = ISO_DATE_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (
    !Number.isInteger(year) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const date = new Date(0);

  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function parseISODateTime(
  value: ISODateTime,
): Date | null {
  if (!ISO_DATE_TIME_PATTERN.test(value)) {
    return null;
  }

  const date = new Date(value);

  return isValidDateObject(date) ? date : null;
}

function getDecimalParts(value: DecimalString): {
  negative: boolean;
  integer: string;
  fraction: string;
} {
  const normalized = normalizeDecimalString(value);

  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new Error("Invalid decimal value.");
  }

  const negative = normalized.startsWith("-");

  const unsigned = negative
    ? normalized.slice(1)
    : normalized;

  const [integer = "0", fraction = ""] =
    unsigned.split(".");

  return {
    negative,
    integer,
    fraction,
  };
}

function validateFractionDigits(
  minimum: number,
  maximum: number,
): void {
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 0 ||
    maximum < minimum ||
    maximum > 100
  ) {
    throw new Error(
      "Invalid decimal formatting precision.",
    );
  }
}

/**
 * Rounds a decimal string using decimal arithmetic rather than
 * binary floating-point arithmetic.
 *
 * This is a display operation only.
 */
export function roundDecimalForDisplay(
  value: DecimalString,
  decimalPlaces: number,
): DecimalString {
  if (
    !Number.isInteger(decimalPlaces) ||
    decimalPlaces < 0 ||
    decimalPlaces > 100
  ) {
    throw new Error(
      "Decimal places must be an integer between 0 and 100.",
    );
  }

  const parts = getDecimalParts(value);

  if (parts.fraction.length <= decimalPlaces) {
    return normalizeDecimalString(value);
  }

  const retainedFraction =
    parts.fraction.slice(0, decimalPlaces);

  const firstDiscardedDigit =
    parts.fraction.charAt(decimalPlaces);

  const shouldRoundUp =
    firstDiscardedDigit >= "5";

  const scale = 10n ** BigInt(decimalPlaces);

  let scaledInteger =
    BigInt(parts.integer) * scale;

  if (decimalPlaces > 0) {
    scaledInteger += BigInt(retainedFraction);
  }

  if (shouldRoundUp) {
    scaledInteger += 1n;
  }

  const roundedInteger =
    scaledInteger / scale;

  const roundedFraction =
    decimalPlaces > 0
      ? (scaledInteger % scale)
          .toString()
          .padStart(decimalPlaces, "0")
      : "";

  const unsignedResult =
    decimalPlaces > 0
      ? `${roundedInteger}.${roundedFraction}`
      : roundedInteger.toString();

  const normalizedResult =
    normalizeDecimalString(unsignedResult);

  return parts.negative && normalizedResult !== "0"
    ? `-${normalizedResult}`
    : normalizedResult;
}

export function formatDecimal(
  value: DecimalString | number | null | undefined,
  options: DecimalFormatOptions = {},
): string {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return EMPTY_VALUE;
  }

  const {
    locale = DEFAULT_LOCALE,
    minimumFractionDigits = 0,
    maximumFractionDigits = 3,
    useGrouping = true,
  } = options;

  validateFractionDigits(
    minimumFractionDigits,
    maximumFractionDigits,
  );

  const rounded = roundDecimalForDisplay(
    normalizeDecimalString(value),
    maximumFractionDigits,
  );

  const parts = getDecimalParts(rounded);

  const integerFormatter = new Intl.NumberFormat(
    locale,
    {
      useGrouping,
      maximumFractionDigits: 0,
    },
  );

  const formattedInteger =
    integerFormatter.format(BigInt(parts.integer));

  const decimalSeparator =
    new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")
      ?.value ?? ".";

  const fraction = parts.fraction
    .padEnd(minimumFractionDigits, "0");

  const formattedValue =
    fraction.length > 0
      ? `${formattedInteger}${decimalSeparator}${fraction}`
      : formattedInteger;

  return parts.negative
    ? `-${formattedValue}`
    : formattedValue;
}

export function formatCurrency(
  value: Money | number | null | undefined,
  options: CurrencyFormatOptions = {},
): string {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return EMPTY_VALUE;
  }

  const {
    locale = DEFAULT_LOCALE,
    currency = DEFAULT_CURRENCY,
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
    showSymbol = true,
  } = options;

  validateFractionDigits(
    minimumFractionDigits,
    maximumFractionDigits,
  );

  const formattedAmount = formatDecimal(
    value,
    {
      locale,
      minimumFractionDigits,
      maximumFractionDigits,
    },
  );

  if (!showSymbol) {
    return formattedAmount;
  }

  const currencyParts = new Intl.NumberFormat(
    locale,
    {
      style: "currency",
      currency,
      currencyDisplay: "symbol",
    },
  ).formatToParts(0);

  const symbol =
    currencyParts.find(
      (part) => part.type === "currency",
    )?.value ?? currency;

  const negative =
    formattedAmount.startsWith("-");

  const unsignedAmount = negative
    ? formattedAmount.slice(1)
    : formattedAmount;

  const prefix = negative ? "-" : "";

  return `${prefix}${symbol}${unsignedAmount}`;
}

export function formatPercentage(
  value: Percentage | number | null | undefined,
  options: DecimalFormatOptions = {},
): string {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return EMPTY_VALUE;
  }

  return `${formatDecimal(value, {
    maximumFractionDigits: 2,
    ...options,
  })}%`;
}

export function formatQuantity(
  value: Quantity | number | null | undefined,
  unit?: UnitOfMeasure | null,
  options: DecimalFormatOptions = {},
): string {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return EMPTY_VALUE;
  }

  const formatted = formatDecimal(value, {
    maximumFractionDigits: 3,
    ...options,
  });

  return unit
    ? `${formatted} ${getUnitSymbol(unit)}`
    : formatted;
}

export function formatNumber(
  value: number | null | undefined,
  options: Intl.NumberFormatOptions = {},
  locale = DEFAULT_LOCALE,
): string {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return EMPTY_VALUE;
  }

  return new Intl.NumberFormat(
    locale,
    options,
  ).format(value);
}

export function formatInteger(
  value: number | null | undefined,
  locale = DEFAULT_LOCALE,
): string {
  return formatNumber(
    value,
    {
      maximumFractionDigits: 0,
    },
    locale,
  );
}

export function isValidISODate(
  value: unknown,
): value is ISODate {
  return (
    typeof value === "string" &&
    parseISODate(value) !== null
  );
}

export function isValidISODateTime(
  value: unknown,
): value is ISODateTime {
  return (
    typeof value === "string" &&
    parseISODateTime(value) !== null
  );
}

export function formatDate(
  value: ISODate | null | undefined,
  options: DateFormatOptions = {},
): string {
  if (!value) {
    return EMPTY_VALUE;
  }

  const date = parseISODate(value);

  if (!date) {
    return EMPTY_VALUE;
  }

  const {
    locale = DEFAULT_LOCALE,
    day = "2-digit",
    month = "short",
    year = "numeric",
  } = options;

  return new Intl.DateTimeFormat(
    locale,
    {
      day,
      month,
      year,
      timeZone: "UTC",
    },
  ).format(date);
}

export function formatDateTime(
  value: ISODateTime | null | undefined,
  options: DateTimeFormatOptions = {},
): string {
  if (!value) {
    return EMPTY_VALUE;
  }

  const date = parseISODateTime(value);

  if (!date) {
    return EMPTY_VALUE;
  }

  const {
    locale = DEFAULT_LOCALE,
    timeZone = DEFAULT_TIME_ZONE,
    day = "2-digit",
    month = "short",
    year = "numeric",
    hour = "2-digit",
    minute = "2-digit",
    second,
    hour12 = true,
  } = options;

  return new Intl.DateTimeFormat(
    locale,
    {
      timeZone,
      day,
      month,
      year,
      hour,
      minute,
      ...(second ? { second } : {}),
      hour12,
    },
  ).format(date);
}

export function formatTime(
  value: ISODateTime | null | undefined,
  options: {
    locale?: string;
    timeZone?: string;
    hour12?: boolean;
    includeSeconds?: boolean;
  } = {},
): string {
  if (!value) {
    return EMPTY_VALUE;
  }

  const date = parseISODateTime(value);

  if (!date) {
    return EMPTY_VALUE;
  }

  const {
    locale = DEFAULT_LOCALE,
    timeZone = DEFAULT_TIME_ZONE,
    hour12 = true,
    includeSeconds = false,
  } = options;

  return new Intl.DateTimeFormat(
    locale,
    {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      ...(includeSeconds
        ? { second: "2-digit" as const }
        : {}),
      hour12,
    },
  ).format(date);
}

export function formatRelativeDateTime(
  value: ISODateTime | null | undefined,
  referenceDate: Date = new Date(),
  locale = DEFAULT_LOCALE,
): string {
  if (!value) {
    return EMPTY_VALUE;
  }

  const date = parseISODateTime(value);

  if (
    !date ||
    !isValidDateObject(referenceDate)
  ) {
    return EMPTY_VALUE;
  }

  const differenceSeconds =
    Math.round(
      (date.getTime() - referenceDate.getTime()) /
        1000,
    );

  const absoluteSeconds =
    Math.abs(differenceSeconds);

  const formatter = new Intl.RelativeTimeFormat(
    locale,
    {
      numeric: "auto",
    },
  );

  if (absoluteSeconds < 60) {
    return formatter.format(
      differenceSeconds,
      "second",
    );
  }

  if (absoluteSeconds < 3600) {
    return formatter.format(
      Math.round(differenceSeconds / 60),
      "minute",
    );
  }

  if (absoluteSeconds < 86400) {
    return formatter.format(
      Math.round(differenceSeconds / 3600),
      "hour",
    );
  }

  if (absoluteSeconds < 604800) {
    return formatter.format(
      Math.round(differenceSeconds / 86400),
      "day",
    );
  }

  return formatDateTime(value);
}

export function formatBoolean(
  value: boolean | null | undefined,
  trueLabel = "Yes",
  falseLabel = "No",
): string {
  if (
    value === null ||
    value === undefined
  ) {
    return EMPTY_VALUE;
  }

  return value ? trueLabel : falseLabel;
}

export function formatStatus(
  value: string | null | undefined,
): string {
  if (!value) {
    return EMPTY_VALUE;
  }

  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (character) =>
      character.toUpperCase(),
    );
}

export function formatPhoneNumber(
  value: string | null | undefined,
): string {
  if (!value) {
    return EMPTY_VALUE;
  }

  return value.trim() || EMPTY_VALUE;
}

export function formatGSTIN(
  value: string | null | undefined,
): string {
  if (!value) {
    return EMPTY_VALUE;
  }

  return value.trim().toUpperCase() || EMPTY_VALUE;
}

export function truncateText(
  value: string | null | undefined,
  maxLength: number,
  suffix = "…",
): string {
  if (!value) {
    return EMPTY_VALUE;
  }

  if (
    !Number.isInteger(maxLength) ||
    maxLength < 0
  ) {
    throw new Error(
      "Maximum text length must be a non-negative integer.",
    );
  }

  const characters = Array.from(value);

  if (characters.length <= maxLength) {
    return value;
  }

  if (maxLength === 0) {
    return suffix;
  }

  return `${characters
    .slice(0, maxLength)
    .join("")
    .trimEnd()}${suffix}`;
}

export function formatFileSize(
  bytes: number | null | undefined,
  locale = DEFAULT_LOCALE,
): string {
  if (
    bytes === null ||
    bytes === undefined ||
    !Number.isFinite(bytes) ||
    bytes < 0
  ) {
    return EMPTY_VALUE;
  }

  const units = [
    "B",
    "KB",
    "MB",
    "GB",
    "TB",
  ] as const;

  let value = bytes;
  let unitIndex = 0;

  while (
    value >= 1024 &&
    unitIndex < units.length - 1
  ) {
    value /= 1024;
    unitIndex += 1;
  }

  const formatted = new Intl.NumberFormat(
    locale,
    {
      maximumFractionDigits:
        unitIndex === 0 ? 0 : 2,
    },
  ).format(value);

  return `${formatted} ${units[unitIndex]}`;
}

export function formatDisplayValue(
  value: string | number | boolean | null | undefined,
): string {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return EMPTY_VALUE;
  }

  if (typeof value === "boolean") {
    return formatBoolean(value);
  }

  if (typeof value === "number") {
    return formatNumber(value);
  }

  return value;
}
