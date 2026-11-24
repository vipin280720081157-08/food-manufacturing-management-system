import type {
  GSTInvoice,
  ISODate,
  Money,
  UUID,
} from "../types/business";

import {
  formatCurrency,
  formatDate,
} from "./formatters";

/**
 * Invoice sharing utilities.
 *
 * Invoice details and monetary amounts must originate from an
 * authoritative backend response. Sharing does not generate,
 * modify, approve, or post financial transactions.
 */

export type InvoiceShareMethod =
  | "native"
  | "whatsapp"
  | "email"
  | "clipboard";

export type InvoiceShareStatus =
  | "shared"
  | "opened"
  | "copied"
  | "cancelled"
  | "unsupported"
  | "failed";

export interface InvoiceShareDetails {
  invoiceId: UUID;
  invoiceNumber: string;
  invoiceDate: ISODate;
  customerName: string;
  totalAmount: Money;
  outstandingAmount: Money;
  invoiceUrl?: string | null;
}

export interface InvoiceShareOptions {
  customerName: string;
  invoiceUrl?: string | null;
  recipientPhone?: string | null;
  recipientEmail?: string | null;
  includeOutstanding?: boolean;
}

export interface InvoiceShareResult {
  method: InvoiceShareMethod;
  status: InvoiceShareStatus;
  message: string;
  error?: string;
}

export interface InvoiceShareContent {
  title: string;
  text: string;
  url?: string;
}

export interface InvoiceShareAvailability {
  nativeShare: boolean;
  whatsapp: boolean;
  email: boolean;
  clipboard: boolean;
}

const WHATSAPP_SHARE_BASE_URL =
  "https://api.whatsapp.com/send";

const EMAIL_SUBJECT_PREFIX = "Invoice";

function isBrowser(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined"
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected sharing error occurred.";
}

function validateInvoiceShareDetails(
  details: InvoiceShareDetails,
): void {
  if (
    !details.invoiceId.trim() ||
    !details.invoiceNumber.trim() ||
    !details.customerName.trim()
  ) {
    throw new Error(
      "Invoice identification and customer information are required.",
    );
  }

  if (
    formatDate(details.invoiceDate) === "—"
  ) {
    throw new Error("A valid invoice date is required.");
  }

  if (
    !details.totalAmount.trim() ||
    !details.outstandingAmount.trim()
  ) {
    throw new Error(
      "Authoritative invoice amounts are required.",
    );
  }

  formatCurrency(details.totalAmount);
  formatCurrency(details.outstandingAmount);

  if (details.invoiceUrl) {
    validateShareableUrl(details.invoiceUrl);
  }
}

/**
 * Only public HTTPS URLs or same-origin application URLs
 * may be included in shareable invoice messages.
 */
export function validateShareableUrl(
  value: string,
): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("An invoice URL is required.");
  }

  let parsed: URL;

  try {
    if (isBrowser()) {
      parsed = new URL(trimmed, window.location.origin);
    } else {
      parsed = new URL(trimmed);
    }
  } catch {
    throw new Error("The invoice URL is invalid.");
  }

  if (
    parsed.protocol !== "https:" &&
    !(
      isBrowser() &&
      parsed.origin === window.location.origin &&
      window.location.protocol === "http:"
    )
  ) {
    throw new Error(
      "Invoice sharing requires a secure or same-origin URL.",
    );
  }

  if (
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "Invoice URLs containing credentials cannot be shared.",
    );
  }

  if (
    isBrowser() &&
    parsed.origin !== window.location.origin &&
    parsed.protocol !== "https:"
  ) {
    throw new Error(
      "External invoice URLs must use HTTPS.",
    );
  }

  return parsed.toString();
}

export function normalizePhoneForWhatsApp(
  phone: string,
): string {
  const trimmed = phone.trim();

  if (!trimmed) {
    throw new Error(
      "A recipient phone number is required.",
    );
  }

  const normalized = trimmed.replace(
    /[\s()+.-]/g,
    "",
  );

  if (
    !/^\d{8,15}$/.test(normalized)
  ) {
    throw new Error(
      "Enter a valid phone number including the country code.",
    );
  }

  return normalized;
}

export function normalizeEmailAddress(
  email: string,
): string {
  const normalized = email.trim();

  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
    /[\r\n]/.test(normalized)
  ) {
    throw new Error(
      "Enter a valid recipient email address.",
    );
  }

  return normalized;
}

export function createInvoiceShareDetails(
  invoice: GSTInvoice,
  options: Pick<
    InvoiceShareOptions,
    "customerName" | "invoiceUrl"
  >,
): InvoiceShareDetails {
  if (invoice.status !== "posted") {
    throw new Error(
      "Only posted invoices can be shared.",
    );
  }

  const details: InvoiceShareDetails = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    customerName: options.customerName.trim(),
    totalAmount: invoice.tax_summary.total_amount,
    outstandingAmount: invoice.outstanding_amount,
    invoiceUrl: options.invoiceUrl ?? null,
  };

  validateInvoiceShareDetails(details);

  return details;
}

export function buildInvoiceShareContent(
  details: InvoiceShareDetails,
  options: {
    includeOutstanding?: boolean;
  } = {},
): InvoiceShareContent {
  validateInvoiceShareDetails(details);

  const {
    includeOutstanding = true,
  } = options;

  const title = `${EMAIL_SUBJECT_PREFIX} ${details.invoiceNumber}`;

  const lines = [
    title,
    `Customer: ${details.customerName}`,
    `Invoice Date: ${formatDate(details.invoiceDate)}`,
    `Invoice Total: ${formatCurrency(details.totalAmount)}`,
  ];

  if (includeOutstanding) {
    lines.push(
      `Outstanding Amount: ${formatCurrency(
        details.outstandingAmount,
      )}`,
    );
  }

  let url: string | undefined;

  if (details.invoiceUrl) {
    url = validateShareableUrl(
      details.invoiceUrl,
    );

    lines.push(`Invoice Link: ${url}`);
  }

  return {
    title,
    text: lines.join("\n"),
    ...(url ? { url } : {}),
  };
}

export function getInvoiceShareAvailability():
  InvoiceShareAvailability {
  if (!isBrowser()) {
    return {
      nativeShare: false,
      whatsapp: false,
      email: false,
      clipboard: false,
    };
  }

  return {
    nativeShare:
      typeof navigator.share === "function",
    whatsapp: true,
    email: true,
    clipboard:
      typeof navigator.clipboard?.writeText ===
      "function",
  };
}

export function buildWhatsAppShareUrl(
  content: InvoiceShareContent,
  recipientPhone?: string | null,
): string {
  const url = new URL(
    WHATSAPP_SHARE_BASE_URL,
  );

  url.searchParams.set(
    "text",
    content.text,
  );

  if (recipientPhone?.trim()) {
    url.searchParams.set(
      "phone",
      normalizePhoneForWhatsApp(
        recipientPhone,
      ),
    );
  }

  return url.toString();
}

export function buildEmailShareUrl(
  content: InvoiceShareContent,
  recipientEmail?: string | null,
): string {
  const recipient = recipientEmail?.trim()
    ? normalizeEmailAddress(recipientEmail)
    : "";

  const parameters = new URLSearchParams({
    subject: content.title,
    body: content.text,
  });

  return `mailto:${recipient}?${parameters.toString()}`;
}

export async function shareInvoiceNatively(
  content: InvoiceShareContent,
): Promise<InvoiceShareResult> {
  if (
    !isBrowser() ||
    typeof navigator.share !== "function"
  ) {
    return {
      method: "native",
      status: "unsupported",
      message:
        "Native sharing is not supported by this browser.",
    };
  }

  try {
    await navigator.share({
      title: content.title,
      text: content.text,
    });

    return {
      method: "native",
      status: "shared",
      message:
        "The invoice was handed to the selected sharing application.",
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        method: "native",
        status: "cancelled",
        message: "Invoice sharing was cancelled.",
      };
    }

    return {
      method: "native",
      status: "failed",
      message: "Unable to share the invoice.",
      error: getErrorMessage(error),
    };
  }
}

export function shareInvoiceViaWhatsApp(
  content: InvoiceShareContent,
  recipientPhone?: string | null,
): InvoiceShareResult {
  if (!isBrowser()) {
    return {
      method: "whatsapp",
      status: "unsupported",
      message:
        "WhatsApp sharing requires a browser.",
    };
  }

  try {
    const url = buildWhatsAppShareUrl(
      content,
      recipientPhone,
    );

    const popup = window.open(
      url,
      "_blank",
      "noopener,noreferrer",
    );

    if (!popup) {
      return {
        method: "whatsapp",
        status: "failed",
        message:
          "The browser could not open WhatsApp. Check popup settings.",
      };
    }

    return {
      method: "whatsapp",
      status: "opened",
      message:
        "WhatsApp was opened. Sending the invoice message requires confirmation in WhatsApp.",
    };
  } catch (error) {
    return {
      method: "whatsapp",
      status: "failed",
      message:
        "Unable to prepare WhatsApp sharing.",
      error: getErrorMessage(error),
    };
  }
}

export function shareInvoiceViaEmail(
  content: InvoiceShareContent,
  recipientEmail?: string | null,
): InvoiceShareResult {
  if (!isBrowser()) {
    return {
      method: "email",
      status: "unsupported",
      message:
        "Email sharing requires a browser.",
    };
  }

  try {
    const url = buildEmailShareUrl(
      content,
      recipientEmail,
    );

    window.location.href = url;

    return {
      method: "email",
      status: "opened",
      message:
        "The email application was requested. Sending the message requires confirmation in the email application.",
    };
  } catch (error) {
    return {
      method: "email",
      status: "failed",
      message:
        "Unable to prepare the invoice email.",
      error: getErrorMessage(error),
    };
  }
}

export async function copyInvoiceShareText(
  content: InvoiceShareContent,
): Promise<InvoiceShareResult> {
  if (
    !isBrowser() ||
    typeof navigator.clipboard?.writeText !==
      "function"
  ) {
    return {
      method: "clipboard",
      status: "unsupported",
      message:
        "Clipboard access is not supported in this browser context.",
    };
  }

  try {
    await navigator.clipboard.writeText(
      content.text,
    );

    return {
      method: "clipboard",
      status: "copied",
      message:
        "Invoice details were copied to the clipboard.",
    };
  } catch (error) {
    return {
      method: "clipboard",
      status: "failed",
      message:
        "Unable to copy the invoice details.",
      error: getErrorMessage(error),
    };
  }
}

export async function shareInvoice(
  invoice: GSTInvoice,
  method: InvoiceShareMethod,
  options: InvoiceShareOptions,
): Promise<InvoiceShareResult> {
  let content: InvoiceShareContent;

  try {
    const details = createInvoiceShareDetails(
      invoice,
      options,
    );

    content = buildInvoiceShareContent(
      details,
      {
        includeOutstanding:
          options.includeOutstanding,
      },
    );
  } catch (error) {
    return {
      method,
      status: "failed",
      message:
        "Unable to prepare invoice sharing.",
      error: getErrorMessage(error),
    };
  }

  switch (method) {
    case "native":
      return shareInvoiceNatively(content);

    case "whatsapp":
      return shareInvoiceViaWhatsApp(
        content,
        options.recipientPhone,
      );

    case "email":
      return shareInvoiceViaEmail(
        content,
        options.recipientEmail,
      );

    case "clipboard":
      return copyInvoiceShareText(content);
  }
}