import type {
  DecimalString,
  ISODate,
  ISODateTime,
  Money,
  PaginatedResponse,
  PaginationParams,
  ProductionStatus,
  Quantity,
  UnitOfMeasure,
  UUID,
} from "../../types/business";

import {
  ApiError,
  apiClient,
  type ApiRequestOptions,
} from "./client";

/**
 * Production, BOM, material movement, and costing API integration.
 *
 * BOM calculations, inventory valuation, stock movements, and
 * production costing are authoritative on the backend.
 * Production completion and material posting are not retried
 * automatically.
 */

export const PRODUCTION_API_PATHS = {
  BOMS: "/production/boms",
  RUNS: "/production/runs",
  COSTING: "/production/costing",
} as const;

export interface ProductionApiRequestOptions
  extends Pick<
    ApiRequestOptions,
    "signal" | "timeoutMs"
  > {
  idempotencyKey?: string;
}

export interface BOMItem {
  id: UUID;
  bom_id: UUID;
  material_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
  wastage_percentage?: DecimalString | null;
}

export interface ProductBOM {
  id: UUID;
  product_id: UUID;
  version: string;
  is_active: boolean;
  standard_output_quantity: Quantity;
  output_unit: UnitOfMeasure;
  notes: string | null;
  items: BOMItem[];
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
  created_by?: UUID | null;
}

export interface BOMItemInput {
  material_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
  wastage_percentage?: DecimalString | null;
}

export interface ProductBOMInput {
  product_id: UUID;
  version: string;
  standard_output_quantity: Quantity;
  output_unit: UnitOfMeasure;
  notes?: string | null;
  items: BOMItemInput[];
}

export interface UpdateProductBOMInput
  extends Partial<ProductBOMInput> {
  is_active?: boolean;
}

export interface ProductionMaterial {
  id: UUID;
  production_run_id: UUID;
  material_id: UUID;
  batch_id: UUID | null;
  issued_quantity: Quantity;
  consumed_quantity: Quantity;
  wasted_quantity: Quantity;
  returned_quantity: Quantity;
  remaining_quantity: Quantity;
  unit: UnitOfMeasure;
  unit_cost: Money | null;
}

export interface ProductionOutput {
  id: UUID;
  production_run_id: UUID;
  product_id: UUID;
  batch_number: string;
  good_quantity: Quantity;
  rejected_quantity: Quantity;
  unit: UnitOfMeasure;
  manufacturing_date: ISODate | null;
  expiry_date: ISODate | null;
}

export interface ProductionExpense {
  id: UUID;
  production_run_id: UUID;
  expense_type: string;
  description: string | null;
  amount: Money;
  incurred_on: ISODate;
  created_at: ISODateTime;
}

export interface ProductionRun {
  id: UUID;
  production_number: string;
  product_id: UUID;
  bom_id: UUID;
  planned_quantity: Quantity;
  output_unit: UnitOfMeasure;
  production_date: ISODate;
  status: ProductionStatus;
  notes: string | null;
  materials: ProductionMaterial[];
  outputs: ProductionOutput[];
  expenses: ProductionExpense[];
  started_at: ISODateTime | null;
  completed_at: ISODateTime | null;
  created_at: ISODateTime;
  updated_at: ISODateTime | null;
  created_by?: UUID | null;
}

export interface ProductionRunInput {
  product_id: UUID;
  bom_id: UUID;
  planned_quantity: Quantity;
  output_unit: UnitOfMeasure;
  production_date?: ISODate;
  notes?: string | null;
}

export type UpdateProductionRunInput = Partial<ProductionRunInput>;

export interface ProductionMaterialMovementInput {
  material_id: UUID;
  batch_id: UUID;
  quantity: Quantity;
  unit: UnitOfMeasure;
  notes?: string | null;
}

export interface ProductionMaterialMovement {
  id: UUID;
  production_run_id: UUID;
  material_id: UUID;
  batch_id: UUID;
  movement_type:
    | "issue"
    | "consumption"
    | "wastage"
    | "return";
  quantity: Quantity;
  unit: UnitOfMeasure;
  created_at: ISODateTime;
  created_by: UUID | null;
}

export interface ProductionOutputInput {
  product_id: UUID;
  batch_number: string;
  good_quantity: Quantity;
  rejected_quantity: Quantity;
  unit: UnitOfMeasure;
  manufacturing_date?: ISODate | null;
  expiry_date?: ISODate | null;
}

export interface ProductionExpenseInput {
  expense_type: string;
  description?: string | null;
  amount: Money;
  incurred_on: ISODate;
}

export interface ProductionCosting {
  id: UUID;
  production_run_id: UUID;
  material_cost: Money;
  packaging_cost: Money;
  production_expenses: Money;
  total_production_cost: Money;
  good_output_quantity: Quantity;
  output_unit: UnitOfMeasure;
  cost_per_unit: Money | null;
  calculated_at: ISODateTime;
  updated_at: ISODateTime | null;
}

export interface BOMListParams
  extends PaginationParams {
  product_id?: UUID;
  is_active?: boolean;
  version?: string;
}

export interface ProductionRunListParams
  extends PaginationParams {
  product_id?: UUID;
  bom_id?: UUID;
  status?: ProductionStatus;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface ProductionCostingListParams
  extends PaginationParams {
  production_run_id?: UUID;
  product_id?: UUID;
  date_from?: ISODate;
  date_to?: ISODate;
}

export interface ProductionMaterialListParams
  extends PaginationParams {
  material_id?: UUID;
  batch_id?: UUID;
}

export interface ProductionExpenseListParams
  extends PaginationParams {
  expense_type?: string;
  date_from?: ISODate;
  date_to?: ISODate;
}

const NON_NEGATIVE_DECIMAL_PATTERN =
  /^\d+(?:\.\d+)?$/;

function validationError(
  message: string,
  code: string,
): ApiError {
  return new ApiError(message, {
    category: "validation",
    code,
  });
}

function requireText(
  value: string,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw validationError(
      `${label} is required.`,
      "REQUIRED_FIELD",
    );
  }

  return value.trim();
}

function requireNonNegativeDecimal(
  value: DecimalString,
  label: string,
): void {
  if (
    typeof value !== "string" ||
    !NON_NEGATIVE_DECIMAL_PATTERN.test(value)
  ) {
    throw validationError(
      `${label} must be a non-negative decimal value.`,
      "INVALID_DECIMAL",
    );
  }
}

function requirePositiveDecimal(
  value: DecimalString,
  label: string,
): void {
  requireNonNegativeDecimal(value, label);

  if (!/[1-9]/.test(value)) {
    throw validationError(
      `${label} must be greater than zero.`,
      "INVALID_QUANTITY",
    );
  }
}

function requireItems<T>(
  items: readonly T[],
  label: string,
): void {
  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    throw validationError(
      `${label} must contain at least one item.`,
      "EMPTY_ITEMS",
    );
  }
}

function requireUpdate(
  request: object,
): void {
  if (Object.keys(request).length === 0) {
    throw validationError(
      "At least one field must be provided.",
      "EMPTY_UPDATE",
    );
  }
}

function resourcePath(
  collection: string,
  id: UUID,
  label: string,
): string {
  return `${collection}/${encodeURIComponent(
    requireText(id, label),
  )}`;
}

function runSubresourcePath(
  runId: UUID,
  suffix: string,
): string {
  return `${resourcePath(
    PRODUCTION_API_PATHS.RUNS,
    runId,
    "Production run ID",
  )}/${suffix}`;
}

function paginationQuery(
  params: PaginationParams,
): {
  page?: number;
  page_size?: number;
  search?: string;
  sort_by?: string;
  sort_direction?: "asc" | "desc";
} {
  return {
    page: params.page,
    page_size: params.page_size,
    search: params.search,
    sort_by: params.sort_by,
    sort_direction: params.sort_direction,
  };
}

function mutationOptions(
  options: ProductionApiRequestOptions,
): ProductionApiRequestOptions {
  if (options.idempotencyKey === undefined) {
    return options;
  }

  const key = requireText(
    options.idempotencyKey,
    "Idempotency key",
  );

  if (
    key.length > 255 ||
    /[\r\n]/.test(key)
  ) {
    throw validationError(
      "The idempotency key is invalid.",
      "INVALID_IDEMPOTENCY_KEY",
    );
  }

  return {
    ...options,
    idempotencyKey: key,
  };
}

function validateBOMItems(
  items: readonly BOMItemInput[],
): void {
  requireItems(items, "Bill of materials");

  items.forEach((item, index) => {
    requireText(
      item.material_id,
      `Material ID at line ${index + 1}`,
    );

    requirePositiveDecimal(
      item.quantity,
      `Material quantity at line ${index + 1}`,
    );

    if (
      item.wastage_percentage !== undefined &&
      item.wastage_percentage !== null
    ) {
      requireNonNegativeDecimal(
        item.wastage_percentage,
        `Wastage percentage at line ${index + 1}`,
      );
    }
  });
}

function validateBOMInput(
  request: ProductBOMInput,
): void {
  requireText(
    request.product_id,
    "Product ID",
  );

  requireText(
    request.version,
    "BOM version",
  );

  requirePositiveDecimal(
    request.standard_output_quantity,
    "Standard output quantity",
  );

  validateBOMItems(request.items);
}

function validateProductionRunInput(
  request: ProductionRunInput,
): void {
  requireText(
    request.product_id,
    "Product ID",
  );

  requireText(
    request.bom_id,
    "BOM ID",
  );

  requirePositiveDecimal(
    request.planned_quantity,
    "Planned production quantity",
  );
}

function validateMaterialMovement(
  request: ProductionMaterialMovementInput,
): void {
  requireText(
    request.material_id,
    "Material ID",
  );

  requireText(
    request.batch_id,
    "Stock batch ID",
  );

  requirePositiveDecimal(
    request.quantity,
    "Material movement quantity",
  );
}

function validateProductionOutput(
  request: ProductionOutputInput,
): void {
  requireText(
    request.product_id,
    "Product ID",
  );

  requireText(
    request.batch_number,
    "Output batch number",
  );

  requirePositiveDecimal(
    request.good_quantity,
    "Good output quantity",
  );

  requireNonNegativeDecimal(
    request.rejected_quantity,
    "Rejected output quantity",
  );

  if (
    request.manufacturing_date &&
    request.expiry_date &&
    request.expiry_date <
      request.manufacturing_date
  ) {
    throw validationError(
      "Expiry date cannot precede manufacturing date.",
      "INVALID_BATCH_DATES",
    );
  }
}

function validateProductionExpense(
  request: ProductionExpenseInput,
): void {
  requireText(
    request.expense_type,
    "Expense type",
  );

  requireText(
    request.incurred_on,
    "Expense date",
  );

  requireNonNegativeDecimal(
    request.amount,
    "Expense amount",
  );
}

/* Bills of materials */

export async function getBOMs(
  params: BOMListParams = {},
  options: ProductionApiRequestOptions = {},
): Promise<PaginatedResponse<ProductBOM>> {
  return apiClient.get<
    PaginatedResponse<ProductBOM>
  >(
    PRODUCTION_API_PATHS.BOMS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        product_id: params.product_id,
        is_active: params.is_active,
        version: params.version,
      },
    },
  );
}

export async function getBOMById(
  bomId: UUID,
  options: ProductionApiRequestOptions = {},
): Promise<ProductBOM> {
  return apiClient.get<ProductBOM>(
    resourcePath(
      PRODUCTION_API_PATHS.BOMS,
      bomId,
      "BOM ID",
    ),
    options,
  );
}

export async function createBOM(
  request: ProductBOMInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductBOM> {
  validateBOMInput(request);

  return apiClient.post<ProductBOM>(
    PRODUCTION_API_PATHS.BOMS,
    request,
    mutationOptions(options),
  );
}

export async function updateBOM(
  bomId: UUID,
  request: UpdateProductBOMInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductBOM> {
  requireUpdate(request);

  if (request.product_id !== undefined) {
    requireText(
      request.product_id,
      "Product ID",
    );
  }

  if (request.version !== undefined) {
    requireText(
      request.version,
      "BOM version",
    );
  }

  if (
    request.standard_output_quantity !==
    undefined
  ) {
    requirePositiveDecimal(
      request.standard_output_quantity,
      "Standard output quantity",
    );
  }

  if (request.items !== undefined) {
    validateBOMItems(request.items);
  }

  return apiClient.patch<ProductBOM>(
    resourcePath(
      PRODUCTION_API_PATHS.BOMS,
      bomId,
      "BOM ID",
    ),
    request,
    mutationOptions(options),
  );
}

export async function setBOMActiveStatus(
  bomId: UUID,
  isActive: boolean,
  options: ProductionApiRequestOptions = {},
): Promise<ProductBOM> {
  return updateBOM(
    bomId,
    {
      is_active: isActive,
    },
    options,
  );
}

/* Production runs */

export async function getProductionRuns(
  params: ProductionRunListParams = {},
  options: ProductionApiRequestOptions = {},
): Promise<PaginatedResponse<ProductionRun>> {
  return apiClient.get<
    PaginatedResponse<ProductionRun>
  >(
    PRODUCTION_API_PATHS.RUNS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        product_id: params.product_id,
        bom_id: params.bom_id,
        status: params.status,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function getProductionRunById(
  runId: UUID,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionRun> {
  return apiClient.get<ProductionRun>(
    resourcePath(
      PRODUCTION_API_PATHS.RUNS,
      runId,
      "Production run ID",
    ),
    options,
  );
}

export async function createProductionRun(
  request: ProductionRunInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionRun> {
  validateProductionRunInput(request);

  return apiClient.post<ProductionRun>(
    PRODUCTION_API_PATHS.RUNS,
    request,
    mutationOptions(options),
  );
}

export async function updateProductionRun(
  runId: UUID,
  request: UpdateProductionRunInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionRun> {
  requireUpdate(request);

  if (request.product_id !== undefined) {
    requireText(
      request.product_id,
      "Product ID",
    );
  }

  if (request.bom_id !== undefined) {
    requireText(
      request.bom_id,
      "BOM ID",
    );
  }

  if (
    request.planned_quantity !== undefined
  ) {
    requirePositiveDecimal(
      request.planned_quantity,
      "Planned production quantity",
    );
  }

  return apiClient.patch<ProductionRun>(
    resourcePath(
      PRODUCTION_API_PATHS.RUNS,
      runId,
      "Production run ID",
    ),
    request,
    mutationOptions(options),
  );
}

export async function startProductionRun(
  runId: UUID,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionRun> {
  return apiClient.post<ProductionRun>(
    runSubresourcePath(runId, "start"),
    undefined,
    mutationOptions(options),
  );
}

export async function completeProductionRun(
  runId: UUID,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionRun> {
  return apiClient.post<ProductionRun>(
    runSubresourcePath(runId, "complete"),
    undefined,
    mutationOptions(options),
  );
}

export async function cancelProductionRun(
  runId: UUID,
  reason: string,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionRun> {
  return apiClient.post<ProductionRun>(
    runSubresourcePath(runId, "cancel"),
    {
      reason: requireText(
        reason,
        "Cancellation reason",
      ),
    },
    mutationOptions(options),
  );
}

/* Production material movements */

export async function getProductionMaterials(
  runId: UUID,
  params: ProductionMaterialListParams = {},
  options: ProductionApiRequestOptions = {},
): Promise<PaginatedResponse<ProductionMaterial>> {
  return apiClient.get<
    PaginatedResponse<ProductionMaterial>
  >(
    runSubresourcePath(runId, "materials"),
    {
      ...options,
      query: {
        ...paginationQuery(params),
        material_id: params.material_id,
        batch_id: params.batch_id,
      },
    },
  );
}

export async function getProductionMaterialMovements(
  runId: UUID,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionMaterialMovement[]> {
  return apiClient.get<
    ProductionMaterialMovement[]
  >(
    runSubresourcePath(
      runId,
      "material-movements",
    ),
    options,
  );
}

export async function issueProductionMaterial(
  runId: UUID,
  request: ProductionMaterialMovementInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionMaterialMovement> {
  validateMaterialMovement(request);

  return apiClient.post<
    ProductionMaterialMovement
  >(
    runSubresourcePath(
      runId,
      "materials/issue",
    ),
    request,
    mutationOptions(options),
  );
}

export async function consumeProductionMaterial(
  runId: UUID,
  request: ProductionMaterialMovementInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionMaterialMovement> {
  validateMaterialMovement(request);

  return apiClient.post<
    ProductionMaterialMovement
  >(
    runSubresourcePath(
      runId,
      "materials/consume",
    ),
    request,
    mutationOptions(options),
  );
}

export async function recordProductionWastage(
  runId: UUID,
  request: ProductionMaterialMovementInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionMaterialMovement> {
  validateMaterialMovement(request);

  return apiClient.post<
    ProductionMaterialMovement
  >(
    runSubresourcePath(
      runId,
      "materials/wastage",
    ),
    request,
    mutationOptions(options),
  );
}

export async function returnProductionMaterial(
  runId: UUID,
  request: ProductionMaterialMovementInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionMaterialMovement> {
  validateMaterialMovement(request);

  return apiClient.post<
    ProductionMaterialMovement
  >(
    runSubresourcePath(
      runId,
      "materials/return",
    ),
    request,
    mutationOptions(options),
  );
}

/* Production outputs */

export async function getProductionOutputs(
  runId: UUID,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionOutput[]> {
  return apiClient.get<ProductionOutput[]>(
    runSubresourcePath(
      runId,
      "outputs",
    ),
    options,
  );
}

export async function recordProductionOutput(
  runId: UUID,
  request: ProductionOutputInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionOutput> {
  validateProductionOutput(request);

  return apiClient.post<ProductionOutput>(
    runSubresourcePath(
      runId,
      "outputs",
    ),
    request,
    mutationOptions(options),
  );
}

/* Production expenses */

export async function getProductionExpenses(
  runId: UUID,
  params: ProductionExpenseListParams = {},
  options: ProductionApiRequestOptions = {},
): Promise<PaginatedResponse<ProductionExpense>> {
  return apiClient.get<
    PaginatedResponse<ProductionExpense>
  >(
    runSubresourcePath(
      runId,
      "expenses",
    ),
    {
      ...options,
      query: {
        ...paginationQuery(params),
        expense_type: params.expense_type,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function addProductionExpense(
  runId: UUID,
  request: ProductionExpenseInput,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionExpense> {
  validateProductionExpense(request);

  return apiClient.post<ProductionExpense>(
    runSubresourcePath(
      runId,
      "expenses",
    ),
    request,
    mutationOptions(options),
  );
}

/* Production costing */

export async function getProductionCosting(
  runId: UUID,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionCosting> {
  return apiClient.get<ProductionCosting>(
    runSubresourcePath(
      runId,
      "costing",
    ),
    options,
  );
}

export async function getProductionCostingList(
  params: ProductionCostingListParams = {},
  options: ProductionApiRequestOptions = {},
): Promise<PaginatedResponse<ProductionCosting>> {
  return apiClient.get<
    PaginatedResponse<ProductionCosting>
  >(
    PRODUCTION_API_PATHS.COSTING,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        production_run_id:
          params.production_run_id,
        product_id: params.product_id,
        date_from: params.date_from,
        date_to: params.date_to,
      },
    },
  );
}

export async function recalculateProductionCosting(
  runId: UUID,
  options: ProductionApiRequestOptions = {},
): Promise<ProductionCosting> {
  return apiClient.post<ProductionCosting>(
    runSubresourcePath(
      runId,
      "costing/recalculate",
    ),
    undefined,
    mutationOptions(options),
  );
}

export const productionApi = {
  getBOMs,
  getBOMById,
  createBOM,
  updateBOM,
  setBOMActiveStatus,

  getProductionRuns,
  getProductionRunById,
  createProductionRun,
  updateProductionRun,
  startProductionRun,
  completeProductionRun,
  cancelProductionRun,

  getProductionMaterials,
  getProductionMaterialMovements,
  issueProductionMaterial,
  consumeProductionMaterial,
  recordProductionWastage,
  returnProductionMaterial,

  getProductionOutputs,
  recordProductionOutput,

  getProductionExpenses,
  addProductionExpense,

  getProductionCosting,
  getProductionCostingList,
  recalculateProductionCosting,
} as const;
