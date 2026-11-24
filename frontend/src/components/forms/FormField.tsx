import {
  forwardRef,
  useId,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import {
  AlertCircle,
  ChevronDown,
} from "lucide-react";

/**
 * Shared accessible form controls.
 *
 * Form values remain controlled by the consuming component.
 * Backend validation remains authoritative for business rules.
 */

export type FormFieldSize = "sm" | "md" | "lg";

export type FormFieldOrientation =
  | "vertical"
  | "horizontal";

export interface FormFieldOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface FormFieldProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "size" | "onChange"
  > {
  label: string;
  error?: string | null;
  helperText?: string;
  fieldSize?: FormFieldSize;
  orientation?: FormFieldOrientation;
  containerClassName?: string;
  labelClassName?: string;
  inputClassName?: string;
  leftAdornment?: ReactNode;
  rightAdornment?: ReactNode;
  onChange?: (
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
}

export interface SelectFieldProps
  extends Omit<
    SelectHTMLAttributes<HTMLSelectElement>,
    "size" | "onChange"
  > {
  label: string;
  options: readonly FormFieldOption[];
  placeholder?: string;
  error?: string | null;
  helperText?: string;
  fieldSize?: FormFieldSize;
  orientation?: FormFieldOrientation;
  containerClassName?: string;
  labelClassName?: string;
  selectClassName?: string;
  onChange?: (
    event: ChangeEvent<HTMLSelectElement>,
  ) => void;
}

export interface TextareaFieldProps
  extends Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "onChange"
  > {
  label: string;
  error?: string | null;
  helperText?: string;
  fieldSize?: FormFieldSize;
  orientation?: FormFieldOrientation;
  containerClassName?: string;
  labelClassName?: string;
  textareaClassName?: string;
  onChange?: (
    event: ChangeEvent<HTMLTextAreaElement>,
  ) => void;
}

export interface CheckboxFieldProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "size" | "onChange"
  > {
  label: string;
  description?: string;
  error?: string | null;
  containerClassName?: string;
  labelClassName?: string;
  onChange?: (
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
}

export interface FormFieldGroupProps {
  legend: string;
  description?: string;
  error?: string | null;
  required?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

const CONTROL_SIZE_CLASSES: Record<
  FormFieldSize,
  string
> = {
  sm: "min-h-9 px-3 py-1.5 text-sm",
  md: "min-h-10 px-3 py-2 text-sm",
  lg: "min-h-12 px-4 py-2.5 text-base",
};

const TEXTAREA_SIZE_CLASSES: Record<
  FormFieldSize,
  string
> = {
  sm: "px-3 py-2 text-sm",
  md: "px-3 py-2.5 text-sm",
  lg: "px-4 py-3 text-base",
};

const CONTROL_BASE_CLASSES = [
  "block w-full min-w-0",
  "rounded-control border",
  "border-border bg-surface",
  "text-text-primary",
  "placeholder:text-text-muted",
  "transition-colors",
  "focus-visible:border-accent",
  "focus-visible:outline-2",
  "focus-visible:outline-offset-1",
  "focus-visible:outline-accent",
  "disabled:cursor-not-allowed",
  "disabled:bg-background",
  "disabled:text-text-muted",
  "disabled:opacity-70",
].join(" ");

const ERROR_CONTROL_CLASSES = [
  "border-error",
  "focus-visible:border-error",
  "focus-visible:outline-error",
].join(" ");

function joinClasses(
  ...classes: Array<
    string | false | null | undefined
  >
): string {
  return classes
    .filter(Boolean)
    .join(" ");
}

function getFieldLayoutClasses(
  orientation: FormFieldOrientation,
): string {
  return orientation === "horizontal"
    ? "grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:items-start sm:gap-4"
    : "flex flex-col gap-1.5";
}

function joinDescribedBy(
  ...ids: Array<string | undefined>
): string | undefined {
  const validIds = ids.filter(
    (id): id is string => Boolean(id),
  );

  return validIds.length > 0
    ? validIds.join(" ")
    : undefined;
}

interface FieldLabelProps {
  htmlFor: string;
  label: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

function FieldLabel({
  htmlFor,
  label,
  required = false,
  disabled = false,
  className,
}: FieldLabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className={joinClasses(
        "app-field-label block text-sm font-medium leading-5",
        "text-text-primary",
        disabled && "opacity-60",
        className,
      )}
    >
      {label}

      {required && (
        <span
          className="ml-1 text-error"
          aria-hidden="true"
        >
          *
        </span>
      )}
    </label>
  );
}

interface FieldMessagesProps {
  helperText?: string;
  error?: string | null;
  helperId: string;
  errorId: string;
}

function FieldMessages({
  helperText,
  error,
  helperId,
  errorId,
}: FieldMessagesProps) {
  return (
    <>
      {helperText && (
        <p
          id={helperId}
          className="app-field-help text-xs leading-5 text-text-muted"
        >
          {helperText}
        </p>
      )}

      {error && (
        <p
          id={errorId}
          className="app-field-error flex items-start gap-1.5 text-xs leading-5 text-error"
          role="alert"
        >
          <AlertCircle
            size={14}
            className="mt-0.5 shrink-0"
            aria-hidden="true"
          />

          <span>{error}</span>
        </p>
      )}
    </>
  );
}

/* Text, number, date, and other native input fields */

export const FormField = forwardRef<
  HTMLInputElement,
  FormFieldProps
>(function FormField(
  {
    id,
    label,
    error,
    helperText,
    fieldSize = "md",
    orientation = "vertical",
    containerClassName,
    labelClassName,
    inputClassName,
    leftAdornment,
    rightAdornment,
    required,
    disabled,
    readOnly,
    type = "text",
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    onChange,
    ...inputProps
  },
  ref,
) {
  const generatedId = useId();

  const fieldId = id ?? generatedId;
  const helperId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;

  const hasError = Boolean(error);

  const describedBy = joinDescribedBy(
    ariaDescribedBy,
    helperText ? helperId : undefined,
    hasError ? errorId : undefined,
  );

  const hasAdornment =
    leftAdornment !== undefined ||
    rightAdornment !== undefined;

  return (
    <div
      className={joinClasses(
        getFieldLayoutClasses(orientation),
        containerClassName,
      )}
    >
      <FieldLabel
        htmlFor={fieldId}
        label={label}
        required={required}
        disabled={disabled}
        className={labelClassName}
      />

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="relative min-w-0">
          {leftAdornment !== undefined && (
            <span
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted"
              aria-hidden="true"
            >
              {leftAdornment}
            </span>
          )}

          <input
            {...inputProps}
            ref={ref}
            id={fieldId}
            type={type}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
            onChange={onChange}
            aria-required={
              required ? true : undefined
            }
            aria-invalid={
              hasError ? true : ariaInvalid
            }
            aria-describedby={describedBy}
            className={joinClasses(
              CONTROL_BASE_CLASSES,
              CONTROL_SIZE_CLASSES[fieldSize],
              hasError && ERROR_CONTROL_CLASSES,
              leftAdornment !== undefined &&
                "app-input-icon-leading",
              rightAdornment !== undefined &&
                "app-input-icon-trailing",
              !hasAdornment && "relative",
              inputClassName,
            )}
          />

          {rightAdornment !== undefined && (
            <span
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted"
              aria-hidden="true"
            >
              {rightAdornment}
            </span>
          )}
        </div>

        <FieldMessages
          helperText={helperText}
          error={error}
          helperId={helperId}
          errorId={errorId}
        />
      </div>
    </div>
  );
});

/* Select fields */

export const SelectField = forwardRef<
  HTMLSelectElement,
  SelectFieldProps
>(function SelectField(
  {
    id,
    label,
    options,
    placeholder,
    error,
    helperText,
    fieldSize = "md",
    orientation = "vertical",
    containerClassName,
    labelClassName,
    selectClassName,
    required,
    disabled,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    onChange,
    ...selectProps
  },
  ref,
) {
  const generatedId = useId();

  const fieldId = id ?? generatedId;
  const helperId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;

  const hasError = Boolean(error);

  const describedBy = joinDescribedBy(
    ariaDescribedBy,
    helperText ? helperId : undefined,
    hasError ? errorId : undefined,
  );

  return (
    <div
      className={joinClasses(
        getFieldLayoutClasses(orientation),
        containerClassName,
      )}
    >
      <FieldLabel
        htmlFor={fieldId}
        label={label}
        required={required}
        disabled={disabled}
        className={labelClassName}
      />

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="relative min-w-0">
          <select
            {...selectProps}
            ref={ref}
            id={fieldId}
            required={required}
            disabled={disabled}
            onChange={onChange}
            aria-required={
              required ? true : undefined
            }
            aria-invalid={
              hasError ? true : ariaInvalid
            }
            aria-describedby={describedBy}
            className={joinClasses(
              CONTROL_BASE_CLASSES,
              CONTROL_SIZE_CLASSES[fieldSize],
              "appearance-none pr-10",
              hasError && ERROR_CONTROL_CLASSES,
              selectClassName,
            )}
          >
            {placeholder !== undefined && (
              <option value="">
                {placeholder}
              </option>
            )}

            {options.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </option>
            ))}
          </select>

          <ChevronDown
            size={17}
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
        </div>

        <FieldMessages
          helperText={helperText}
          error={error}
          helperId={helperId}
          errorId={errorId}
        />
      </div>
    </div>
  );
});

/* Multiline text fields */

export const TextareaField = forwardRef<
  HTMLTextAreaElement,
  TextareaFieldProps
>(function TextareaField(
  {
    id,
    label,
    error,
    helperText,
    fieldSize = "md",
    orientation = "vertical",
    containerClassName,
    labelClassName,
    textareaClassName,
    required,
    disabled,
    rows = 4,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    onChange,
    ...textareaProps
  },
  ref,
) {
  const generatedId = useId();

  const fieldId = id ?? generatedId;
  const helperId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;

  const hasError = Boolean(error);

  const describedBy = joinDescribedBy(
    ariaDescribedBy,
    helperText ? helperId : undefined,
    hasError ? errorId : undefined,
  );

  return (
    <div
      className={joinClasses(
        getFieldLayoutClasses(orientation),
        containerClassName,
      )}
    >
      <FieldLabel
        htmlFor={fieldId}
        label={label}
        required={required}
        disabled={disabled}
        className={labelClassName}
      />

      <div className="flex min-w-0 flex-col gap-1.5">
        <textarea
          {...textareaProps}
          ref={ref}
          id={fieldId}
          rows={rows}
          required={required}
          disabled={disabled}
          onChange={onChange}
          aria-required={
            required ? true : undefined
          }
          aria-invalid={
            hasError ? true : ariaInvalid
          }
          aria-describedby={describedBy}
          className={joinClasses(
            CONTROL_BASE_CLASSES,
            TEXTAREA_SIZE_CLASSES[fieldSize],
            "min-h-24 resize-y",
            hasError && ERROR_CONTROL_CLASSES,
            textareaClassName,
          )}
        />

        <FieldMessages
          helperText={helperText}
          error={error}
          helperId={helperId}
          errorId={errorId}
        />
      </div>
    </div>
  );
});

/* Checkbox fields */

export const CheckboxField = forwardRef<
  HTMLInputElement,
  CheckboxFieldProps
>(function CheckboxField(
  {
    id,
    label,
    description,
    error,
    containerClassName,
    labelClassName,
    required,
    disabled,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    onChange,
    ...inputProps
  },
  ref,
) {
  const generatedId = useId();

  const fieldId = id ?? generatedId;
  const descriptionId =
    `${fieldId}-description`;
  const errorId = `${fieldId}-error`;

  const hasError = Boolean(error);

  const describedBy = joinDescribedBy(
    ariaDescribedBy,
    description ? descriptionId : undefined,
    hasError ? errorId : undefined,
  );

  return (
    <div
      className={joinClasses(
        "flex flex-col gap-1.5",
        containerClassName,
      )}
    >
      <div className="flex items-start gap-3">
        <input
          {...inputProps}
          ref={ref}
          id={fieldId}
          type="checkbox"
          required={required}
          disabled={disabled}
          onChange={onChange}
          aria-required={
            required ? true : undefined
          }
          aria-invalid={
            hasError ? true : ariaInvalid
          }
          aria-describedby={describedBy}
          className={joinClasses(
            "mt-0.5 h-4 w-4 shrink-0",
            "rounded border-border",
            "accent-primary",
            "focus-visible:outline-2",
            "focus-visible:outline-offset-2",
            "focus-visible:outline-accent",
            "disabled:cursor-not-allowed",
            "disabled:opacity-60",
          )}
        />

        <div className="min-w-0">
          <FieldLabel
            htmlFor={fieldId}
            label={label}
            required={required}
            disabled={disabled}
            className={labelClassName}
          />

          {description && (
            <p
              id={descriptionId}
              className="mt-1 text-xs leading-5 text-text-muted"
            >
              {description}
            </p>
          )}
        </div>
      </div>

      {error && (
        <p
          id={errorId}
          role="alert"
          className="app-field-error flex items-start gap-1.5 text-xs text-error"
        >
          <AlertCircle
            size={14}
            className="mt-0.5 shrink-0"
            aria-hidden="true"
          />

          <span>{error}</span>
        </p>
      )}
    </div>
  );
});

/* Semantic field grouping */

export function FormFieldGroup({
  legend,
  description,
  error,
  required = false,
  disabled = false,
  children,
  className,
  contentClassName,
}: FormFieldGroupProps) {
  const generatedId = useId();

  const descriptionId =
    `${generatedId}-description`;
  const errorId = `${generatedId}-error`;

  const describedBy = joinDescribedBy(
    description ? descriptionId : undefined,
    error ? errorId : undefined,
  );

  return (
    <fieldset
      disabled={disabled}
      aria-describedby={describedBy}
      aria-invalid={
        error ? true : undefined
      }
      className={joinClasses(
        "min-w-0 space-y-4",
        className,
      )}
    >
      <legend className="text-sm font-semibold text-text-primary">
        {legend}

        {required && (
          <span
            className="ml-1 text-error"
            aria-hidden="true"
          >
            *
          </span>
        )}
      </legend>

      {description && (
        <p
          id={descriptionId}
          className="text-sm leading-5 text-text-muted"
        >
          {description}
        </p>
      )}

      <div
        className={joinClasses(
          "space-y-4",
          contentClassName,
        )}
      >
        {children}
      </div>

      {error && (
        <p
          id={errorId}
          role="alert"
          className="app-field-error flex items-start gap-1.5 text-xs text-error"
        >
          <AlertCircle
            size={14}
            className="mt-0.5 shrink-0"
            aria-hidden="true"
          />

          <span>{error}</span>
        </p>
      )}
    </fieldset>
  );
}

export default FormField;
