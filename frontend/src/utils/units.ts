
import type {
  DecimalString,
  Quantity,
  UnitConversion,
  UnitOfMeasure,
} from "../types/business";

/**
 * Unit conversion utilities for frontend display and input validation.
 *
 * Inventory quantities, BOM consumption, costing, and stock movements
 * remain authoritative on the backend.
 */

export const UNIT_LABELS: Record<UnitOfMeasure, string> = {
  kg: "Kilograms",
  g: "Grams",
  l: "Litres",
  ml: "Millilitres",
  pcs: "Pieces",
  packets: "Packets",
  cartons: "Cartons",
};

export const UNIT_SYMBOLS: Record<UnitOfMeasure, string> = {
  kg: "kg",
  g: "g",
  l: "L",
  ml: "mL",
  pcs: "pcs",
  packets: "packets",
  cartons: "cartons",
};

export const UNIT_GROUPS = {
  MASS: ["kg", "g"],
  VOLUME: ["l", "ml"],
  COUNT: ["pcs"],
  PACKETS: ["packets"],
  CARTONS: ["cartons"],
} as const satisfies Record<string, readonly UnitOfMeasure[]>;

export const ALL_UNITS: readonly UnitOfMeasure[] = [
  "kg",
  "g",
  "l",
  "ml",
  "pcs",
  "packets",
  "cartons",
];

export type UnitGroup = keyof typeof UNIT_GROUPS;

export interface UnitOption {
  value: UnitOfMeasure;
  label: string;
  symbol: string;
}

export const UNIT_OPTIONS: readonly UnitOption[] = ALL_UNITS.map(
  (unit) => ({
    value: unit,
    label: UNIT_LABELS[unit],
    symbol: UNIT_SYMBOLS[unit],
  }),
);

export interface QuantityValidationOptions {
  allowZero?: boolean;
  allowNegative?: boolean;
  maxDecimalPlaces?: number;
}

export interface QuantityValidationResult {
  valid: boolean;
  normalizedValue: Quantity | null;
  error: string | null;
}

export interface UnitConversionResult {
  quantity: Quantity;
  fromUnit: UnitOfMeasure;
  toUnit: UnitOfMeasure;
  conversionFactor: DecimalString;
}

const DECIMAL_PATTERN = /^-?(?:\d+)(?:\.\d+)?$/;

const INTEGER_UNITS: readonly UnitOfMeasure[] = [
  "pcs",
  "packets",
  "cartons",
];

const FIXED_CONVERSION_FACTORS: Readonly<
  Partial<Record<UnitOfMeasure, Partial<Record<UnitOfMeasure, string>>>>
> = {
  kg: {
    g: "1000",
  },
  g: {
    kg: "0.001",
  },
  l: {
    ml: "1000",
  },
  ml: {
    l: "0.001",
  },
};

function parseDecimalParts(value: string): {
  negative: boolean;
  digits: bigint;
  scale: number;
} {
  const normalized = value.trim();

  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new Error("A valid decimal quantity is required.");
  }

  const negative = normalized.startsWith("-");
  const unsigned = negative
    ? normalized.slice(1)
    : normalized;

  const [integerPart = "0", fractionalPart = ""] =
    unsigned.split(".");

  const digits = BigInt(`${integerPart}${fractionalPart}`);

  return {
    negative: negative && digits !== 0n,
    digits,
    scale: fractionalPart.length,
  };
}

function decimalFromParts(
  negative: boolean,
  digits: bigint,
  scale: number,
): DecimalString {
  if (scale < 0 || !Number.isInteger(scale)) {
    throw new Error("Invalid decimal scale.");
  }

  if (digits === 0n) {
    return "0";
  }

  let text = digits.toString();

  if (scale > 0) {
    text = text.padStart(scale + 1, "0");

    const splitIndex = text.length - scale;

    text = `${text.slice(0, splitIndex)}.${text.slice(splitIndex)}`;
    text = text.replace(/0+$/, "").replace(/\.$/, "");
  }

  return negative ? `-${text}` : text;
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new Error("Invalid decimal exponent.");
  }

  return 10n ** BigInt(exponent);
}

export function isUnitOfMeasure(
  value: unknown,
): value is UnitOfMeasure {
  return (
    typeof value === "string" &&
    ALL_UNITS.some((unit) => unit === value)
  );
}

export function getUnitGroup(
  unit: UnitOfMeasure,
): UnitGroup {
  for (const group of Object.keys(UNIT_GROUPS) as UnitGroup[]) {
    const members: readonly UnitOfMeasure[] = UNIT_GROUPS[group];

    if (members.includes(unit)) {
      return group;
    }
  }

  throw new Error(`Unsupported unit of measure: ${unit}`);
}

export function isCountUnit(
  unit: UnitOfMeasure,
): boolean {
  return INTEGER_UNITS.includes(unit);
}

export function getUnitLabel(
  unit: UnitOfMeasure,
): string {
  return UNIT_LABELS[unit];
}

export function getUnitSymbol(
  unit: UnitOfMeasure,
): string {
  return UNIT_SYMBOLS[unit];
}

export function normalizeDecimalString(
  value: string | number,
): DecimalString {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Quantity must be a finite number.");
    }

    const numericText = value.toString();

    if (/[eE]/.test(numericText)) {
      throw new Error(
        "Scientific notation is not supported for exact decimal quantities.",
      );
    }

    value = numericText;
  }

  const parsed = parseDecimalParts(value);

  return decimalFromParts(
    parsed.negative,
    parsed.digits,
    parsed.scale,
  );
}

export function getDecimalPlaces(
  value: string | number,
): number {
  const normalized = normalizeDecimalString(value);
  const decimalIndex = normalized.indexOf(".");

  return decimalIndex === -1
    ? 0
    : normalized.length - decimalIndex - 1;
}

export function compareDecimalStrings(
  first: DecimalString,
  second: DecimalString,
): -1 | 0 | 1 {
  const left = parseDecimalParts(first);
  const right = parseDecimalParts(second);

  const commonScale = Math.max(left.scale, right.scale);

  const leftValue =
    (left.negative ? -left.digits : left.digits) *
    powerOfTen(commonScale - left.scale);

  const rightValue =
    (right.negative ? -right.digits : right.digits) *
    powerOfTen(commonScale - right.scale);

  if (leftValue < rightValue) {
    return -1;
  }

  if (leftValue > rightValue) {
    return 1;
  }

  return 0;
}

export function addDecimalStrings(
  first: DecimalString,
  second: DecimalString,
): DecimalString {
  const left = parseDecimalParts(first);
  const right = parseDecimalParts(second);

  const commonScale = Math.max(left.scale, right.scale);

  const leftValue =
    (left.negative ? -left.digits : left.digits) *
    powerOfTen(commonScale - left.scale);

  const rightValue =
    (right.negative ? -right.digits : right.digits) *
    powerOfTen(commonScale - right.scale);

  const result = leftValue + rightValue;

  return decimalFromParts(
    result < 0n,
    result < 0n ? -result : result,
    commonScale,
  );
}

export function subtractDecimalStrings(
  first: DecimalString,
  second: DecimalString,
): DecimalString {
  const normalizedSecond = normalizeDecimalString(second);

  const negatedSecond =
    normalizedSecond.startsWith("-")
      ? normalizedSecond.slice(1)
      : normalizedSecond === "0"
        ? "0"
        : `-${normalizedSecond}`;

  return addDecimalStrings(first, negatedSecond);
}

export function multiplyDecimalStrings(
  first: DecimalString,
  second: DecimalString,
): DecimalString {
  const left = parseDecimalParts(first);
  const right = parseDecimalParts(second);

  return decimalFromParts(
    left.negative !== right.negative,
    left.digits * right.digits,
    left.scale + right.scale,
  );
}

export function validateQuantity(
  value: string | number,
  unit: UnitOfMeasure,
  options: QuantityValidationOptions = {},
): QuantityValidationResult {
  const {
    allowZero = false,
    allowNegative = false,
    maxDecimalPlaces,
  } = options;

  let normalizedValue: DecimalString;

  try {
    normalizedValue = normalizeDecimalString(value);
  } catch {
    return {
      valid: false,
      normalizedValue: null,
      error: "Enter a valid decimal quantity.",
    };
  }

  const comparison = compareDecimalStrings(
    normalizedValue,
    "0",
  );

  if (!allowNegative && comparison < 0) {
    return {
      valid: false,
      normalizedValue: null,
      error: "Quantity cannot be negative.",
    };
  }

  if (!allowZero && comparison === 0) {
    return {
      valid: false,
      normalizedValue: null,
      error: "Quantity must be greater than zero.",
    };
  }

  if (isCountUnit(unit) && getDecimalPlaces(normalizedValue) > 0) {
    return {
      valid: false,
      normalizedValue: null,
      error: `${UNIT_LABELS[unit]} must be entered as whole numbers.`,
    };
  }

  if (
    maxDecimalPlaces !== undefined &&
    (
      !Number.isInteger(maxDecimalPlaces) ||
      maxDecimalPlaces < 0
    )
  ) {
    throw new Error(
      "Maximum decimal places must be a non-negative integer.",
    );
  }

  if (
    maxDecimalPlaces !== undefined &&
    getDecimalPlaces(normalizedValue) > maxDecimalPlaces
  ) {
    return {
      valid: false,
      normalizedValue: null,
      error: `Quantity cannot exceed ${maxDecimalPlaces} decimal places.`,
    };
  }

  return {
    valid: true,
    normalizedValue,
    error: null,
  };
}

export function getFixedConversionFactor(
  fromUnit: UnitOfMeasure,
  toUnit: UnitOfMeasure,
): DecimalString | null {
  if (fromUnit === toUnit) {
    return "1";
  }

  return FIXED_CONVERSION_FACTORS[fromUnit]?.[toUnit] ?? null;
}

export function areUnitsCompatible(
  fromUnit: UnitOfMeasure,
  toUnit: UnitOfMeasure,
  conversions: readonly UnitConversion[] = [],
): boolean {
  if (fromUnit === toUnit) {
    return true;
  }

  if (getFixedConversionFactor(fromUnit, toUnit) !== null) {
    return true;
  }

  return conversions.some(
    (conversion) =>
      (
        conversion.from_unit === fromUnit &&
        conversion.to_unit === toUnit
      ) ||
      (
        conversion.from_unit === toUnit &&
        conversion.to_unit === fromUnit
      ),
  );
}

export function divideDecimalStringsExact(
  numerator: DecimalString,
  denominator: DecimalString,
): DecimalString {
  const left = parseDecimalParts(numerator);
  const right = parseDecimalParts(denominator);

  if (right.digits === 0n) {
    throw new Error("Division by zero is not permitted.");
  }

  if (left.digits === 0n) {
    return "0";
  }

  let numeratorInteger =
    left.digits * powerOfTen(right.scale);

  let denominatorInteger =
    right.digits * powerOfTen(left.scale);

  const gcd = (a: bigint, b: bigint): bigint => {
    while (b !== 0n) {
      const remainder = a % b;
      a = b;
      b = remainder;
    }

    return a;
  };

  const divisor = gcd(numeratorInteger, denominatorInteger);

  numeratorInteger /= divisor;
  denominatorInteger /= divisor;

  let remainingDenominator = denominatorInteger;
  let factorsOfTwo = 0;
  let factorsOfFive = 0;

  while (remainingDenominator % 2n === 0n) {
    remainingDenominator /= 2n;
    factorsOfTwo += 1;
  }

  while (remainingDenominator % 5n === 0n) {
    remainingDenominator /= 5n;
    factorsOfFive += 1;
  }

  if (remainingDenominator !== 1n) {
    throw new Error(
      "The conversion cannot be represented as a finite exact decimal.",
    );
  }

  const scale = Math.max(factorsOfTwo, factorsOfFive);

  const scaledNumerator =
    numeratorInteger * powerOfTen(scale);

  const quotient =
    scaledNumerator / denominatorInteger;

  return decimalFromParts(
    left.negative !== right.negative,
    quotient,
    scale,
  );
}

export function getConversionFactor(
  fromUnit: UnitOfMeasure,
  toUnit: UnitOfMeasure,
  conversions: readonly UnitConversion[] = [],
): DecimalString {
  const fixedFactor = getFixedConversionFactor(
    fromUnit,
    toUnit,
  );

  if (fixedFactor !== null) {
    return fixedFactor;
  }

  const directConversion = conversions.find(
    (conversion) =>
      conversion.from_unit === fromUnit &&
      conversion.to_unit === toUnit,
  );

  if (directConversion) {
    const factor = normalizeDecimalString(
      directConversion.conversion_factor,
    );

    if (compareDecimalStrings(factor, "0") <= 0) {
      throw new Error(
        "Unit conversion factors must be greater than zero.",
      );
    }

    return factor;
  }

  const reverseConversion = conversions.find(
    (conversion) =>
      conversion.from_unit === toUnit &&
      conversion.to_unit === fromUnit,
  );

  if (reverseConversion) {
    const factor = normalizeDecimalString(
      reverseConversion.conversion_factor,
    );

    if (compareDecimalStrings(factor, "0") <= 0) {
      throw new Error(
        "Unit conversion factors must be greater than zero.",
      );
    }

    return divideDecimalStringsExact("1", factor);
  }

  throw new Error(
    `No defined conversion exists between ${fromUnit} and ${toUnit}.`,
  );
}

export function convertQuantity(
  quantity: Quantity,
  fromUnit: UnitOfMeasure,
  toUnit: UnitOfMeasure,
  conversions: readonly UnitConversion[] = [],
): UnitConversionResult {
  const normalizedQuantity = normalizeDecimalString(quantity);

  const sourceValidation = validateQuantity(
    normalizedQuantity,
    fromUnit,
    {
      allowZero: true,
      allowNegative: false,
    },
  );

  if (!sourceValidation.valid) {
    throw new Error(
      sourceValidation.error ?? "Invalid source quantity.",
    );
  }

  const factor = getConversionFactor(
    fromUnit,
    toUnit,
    conversions,
  );

  const convertedQuantity = multiplyDecimalStrings(
    normalizedQuantity,
    factor,
  );

  const targetValidation = validateQuantity(
    convertedQuantity,
    toUnit,
    {
      allowZero: true,
      allowNegative: false,
    },
  );

  if (!targetValidation.valid) {
    throw new Error(
      targetValidation.error ?? "Invalid converted quantity.",
    );
  }

  return {
    quantity: convertedQuantity,
    fromUnit,
    toUnit,
    conversionFactor: factor,
  };
}

export function formatQuantityWithUnit(
  quantity: Quantity,
  unit: UnitOfMeasure,
  locale = "en-IN",
): string {
  const normalized = normalizeDecimalString(quantity);

  const [integerPart = "0", fractionalPart] =
    normalized.split(".");

  const formattedInteger = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(BigInt(integerPart));

  const formattedQuantity = fractionalPart
    ? `${formattedInteger}.${fractionalPart}`
    : formattedInteger;

  return `${formattedQuantity} ${getUnitSymbol(unit)}`;
}
