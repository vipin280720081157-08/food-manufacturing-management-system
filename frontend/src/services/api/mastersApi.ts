import type {
  Customer,
  CustomerInput,
  InventoryItem,
  InventoryItemInput,
  PaginatedResponse,
  PaginationParams,
  PriceList,
  PriceListInput,
  Product,
  ProductInput,
  Supplier,
  SupplierInput,
  UUID,
  UnitConversion,
  UnitOfMeasure,
} from "../../types/business";

import {
  ApiError,
  apiClient,
  type ApiRequestOptions,
} from "./client";

/**
 * Master-data API integration.
 *
 * Master records, customer assignments, product pricing, and
 * unit conversions are validated and enforced by the backend.
 * Mutations are not automatically retried.
 */

export const MASTERS_API_PATHS = {
  CUSTOMERS: "/customers",
  SUPPLIERS: "/suppliers",
  INVENTORY_ITEMS: "/inventory-items",
  PRODUCTS: "/products",
  PRICE_LISTS: "/price-lists",
  UNIT_CONVERSIONS: "/unit-conversions",
} as const;

export type MastersApiRequestOptions = Pick<ApiRequestOptions, "signal" | "timeoutMs">;

export interface CustomerListParams
  extends PaginationParams {
  assigned_salesman_id?: UUID;
  is_active?: boolean;
}

export interface SupplierListParams
  extends PaginationParams {
  is_active?: boolean;
}

export interface InventoryItemListParams
  extends PaginationParams {
  item_type?:
    | "raw_material"
    | "packaging_material"
    | "finished_product";
  is_active?: boolean;
}

export interface ProductListParams
  extends PaginationParams {
  is_active?: boolean;
}

export interface PriceListParams
  extends PaginationParams {
  is_active?: boolean;
  effective_on?: string;
}

export type UpdateCustomerInput = Partial<CustomerInput>;

export type UpdateSupplierInput = Partial<SupplierInput>;

export type UpdateInventoryItemInput = Partial<InventoryItemInput>;

export type UpdateProductInput = Partial<ProductInput>;

export type UpdatePriceListInput = Partial<PriceListInput>;

export interface UnitConversionInput {
  from_unit: UnitOfMeasure;
  to_unit: UnitOfMeasure;
  conversion_factor: string;
}

function requireIdentifier(
  value: UUID,
  label: string,
): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new ApiError(
      `${label} is required.`,
      {
        category: "validation",
        code: "REQUIRED_IDENTIFIER",
      },
    );
  }

  return encodeURIComponent(normalized);
}

function requireText(
  value: string,
  label: string,
): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new ApiError(
      `${label} is required.`,
      {
        category: "validation",
        code: "REQUIRED_FIELD",
      },
    );
  }

  return normalized;
}

function validateUpdate(
  request: object,
): void {
  if (Object.keys(request).length === 0) {
    throw new ApiError(
      "At least one field must be provided.",
      {
        category: "validation",
        code: "EMPTY_UPDATE",
      },
    );
  }
}

function resourcePath(
  collectionPath: string,
  id: UUID,
  label: string,
): string {
  return `${collectionPath}/${requireIdentifier(
    id,
    label,
  )}`;
}

function paginationQuery(
  params: PaginationParams,
): Record<
  string,
  string | number | undefined
> {
  return {
    page: params.page,
    page_size: params.page_size,
    search: params.search,
    sort_by: params.sort_by,
    sort_direction: params.sort_direction,
  };
}

/* Customers */

export async function getCustomers(
  params: CustomerListParams = {},
  options: MastersApiRequestOptions = {},
): Promise<PaginatedResponse<Customer>> {
  return apiClient.get<
    PaginatedResponse<Customer>
  >(
    MASTERS_API_PATHS.CUSTOMERS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        assigned_salesman_id:
          params.assigned_salesman_id,
        is_active: params.is_active,
      },
    },
  );
}

export async function getCustomerById(
  customerId: UUID,
  options: MastersApiRequestOptions = {},
): Promise<Customer> {
  return apiClient.get<Customer>(
    resourcePath(
      MASTERS_API_PATHS.CUSTOMERS,
      customerId,
      "Customer ID",
    ),
    options,
  );
}

export async function createCustomer(
  request: CustomerInput,
  options: MastersApiRequestOptions = {},
): Promise<Customer> {
  return apiClient.post<Customer>(
    MASTERS_API_PATHS.CUSTOMERS,
    {
      ...request,
      customer_code: requireText(
        request.customer_code,
        "Customer code",
      ),
      name: requireText(
        request.name,
        "Customer name",
      ),
      assigned_salesman_id: requireText(
        request.assigned_salesman_id,
        "Assigned salesman",
      ),
    },
    options,
  );
}

export async function updateCustomer(
  customerId: UUID,
  request: UpdateCustomerInput,
  options: MastersApiRequestOptions = {},
): Promise<Customer> {
  validateUpdate(request);

  return apiClient.patch<Customer>(
    resourcePath(
      MASTERS_API_PATHS.CUSTOMERS,
      customerId,
      "Customer ID",
    ),
    request,
    options,
  );
}

export async function setCustomerActiveStatus(
  customerId: UUID,
  isActive: boolean,
  options: MastersApiRequestOptions = {},
): Promise<Customer> {
  return updateCustomer(
    customerId,
    {
      is_active: isActive,
    },
    options,
  );
}

/* Suppliers */

export async function getSuppliers(
  params: SupplierListParams = {},
  options: MastersApiRequestOptions = {},
): Promise<PaginatedResponse<Supplier>> {
  return apiClient.get<
    PaginatedResponse<Supplier>
  >(
    MASTERS_API_PATHS.SUPPLIERS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        is_active: params.is_active,
      },
    },
  );
}

export async function getSupplierById(
  supplierId: UUID,
  options: MastersApiRequestOptions = {},
): Promise<Supplier> {
  return apiClient.get<Supplier>(
    resourcePath(
      MASTERS_API_PATHS.SUPPLIERS,
      supplierId,
      "Supplier ID",
    ),
    options,
  );
}

export async function createSupplier(
  request: SupplierInput,
  options: MastersApiRequestOptions = {},
): Promise<Supplier> {
  return apiClient.post<Supplier>(
    MASTERS_API_PATHS.SUPPLIERS,
    {
      ...request,
      supplier_code: requireText(
        request.supplier_code,
        "Supplier code",
      ),
      name: requireText(
        request.name,
        "Supplier name",
      ),
    },
    options,
  );
}

export async function updateSupplier(
  supplierId: UUID,
  request: UpdateSupplierInput,
  options: MastersApiRequestOptions = {},
): Promise<Supplier> {
  validateUpdate(request);

  return apiClient.patch<Supplier>(
    resourcePath(
      MASTERS_API_PATHS.SUPPLIERS,
      supplierId,
      "Supplier ID",
    ),
    request,
    options,
  );
}

export async function setSupplierActiveStatus(
  supplierId: UUID,
  isActive: boolean,
  options: MastersApiRequestOptions = {},
): Promise<Supplier> {
  return updateSupplier(
    supplierId,
    {
      is_active: isActive,
    },
    options,
  );
}

/* Inventory Items */

export async function getInventoryItems(
  params: InventoryItemListParams = {},
  options: MastersApiRequestOptions = {},
): Promise<PaginatedResponse<InventoryItem>> {
  return apiClient.get<
    PaginatedResponse<InventoryItem>
  >(
    MASTERS_API_PATHS.INVENTORY_ITEMS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        item_type: params.item_type,
        is_active: params.is_active,
      },
    },
  );
}

export async function getInventoryItemById(
  itemId: UUID,
  options: MastersApiRequestOptions = {},
): Promise<InventoryItem> {
  return apiClient.get<InventoryItem>(
    resourcePath(
      MASTERS_API_PATHS.INVENTORY_ITEMS,
      itemId,
      "Inventory item ID",
    ),
    options,
  );
}

export async function createInventoryItem(
  request: InventoryItemInput,
  options: MastersApiRequestOptions = {},
): Promise<InventoryItem> {
  return apiClient.post<InventoryItem>(
    MASTERS_API_PATHS.INVENTORY_ITEMS,
    {
      ...request,
      item_code: requireText(
        request.item_code,
        "Item code",
      ),
      name: requireText(
        request.name,
        "Item name",
      ),
    },
    options,
  );
}

export async function updateInventoryItem(
  itemId: UUID,
  request: UpdateInventoryItemInput,
  options: MastersApiRequestOptions = {},
): Promise<InventoryItem> {
  validateUpdate(request);

  return apiClient.patch<InventoryItem>(
    resourcePath(
      MASTERS_API_PATHS.INVENTORY_ITEMS,
      itemId,
      "Inventory item ID",
    ),
    request,
    options,
  );
}

export async function setInventoryItemActiveStatus(
  itemId: UUID,
  isActive: boolean,
  options: MastersApiRequestOptions = {},
): Promise<InventoryItem> {
  return updateInventoryItem(
    itemId,
    {
      is_active: isActive,
    },
    options,
  );
}

/* Finished Products */

export async function getProducts(
  params: ProductListParams = {},
  options: MastersApiRequestOptions = {},
): Promise<PaginatedResponse<Product>> {
  return apiClient.get<
    PaginatedResponse<Product>
  >(
    MASTERS_API_PATHS.PRODUCTS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        is_active: params.is_active,
      },
    },
  );
}

export async function getProductById(
  productId: UUID,
  options: MastersApiRequestOptions = {},
): Promise<Product> {
  return apiClient.get<Product>(
    resourcePath(
      MASTERS_API_PATHS.PRODUCTS,
      productId,
      "Product ID",
    ),
    options,
  );
}

export async function createProduct(
  request: ProductInput,
  options: MastersApiRequestOptions = {},
): Promise<Product> {
  return apiClient.post<Product>(
    MASTERS_API_PATHS.PRODUCTS,
    {
      ...request,
      item_code: requireText(
        request.item_code,
        "Item code",
      ),
      name: requireText(
        request.name,
        "Product name",
      ),
      sku: requireText(
        request.sku,
        "Product SKU",
      ),
      hsn_code: requireText(
        request.hsn_code,
        "HSN code",
      ),
    },
    options,
  );
}

export async function updateProduct(
  productId: UUID,
  request: UpdateProductInput,
  options: MastersApiRequestOptions = {},
): Promise<Product> {
  validateUpdate(request);

  return apiClient.patch<Product>(
    resourcePath(
      MASTERS_API_PATHS.PRODUCTS,
      productId,
      "Product ID",
    ),
    request,
    options,
  );
}

export async function setProductActiveStatus(
  productId: UUID,
  isActive: boolean,
  options: MastersApiRequestOptions = {},
): Promise<Product> {
  return updateProduct(
    productId,
    {
      is_active: isActive,
    },
    options,
  );
}

/* Price Lists */

export async function getPriceLists(
  params: PriceListParams = {},
  options: MastersApiRequestOptions = {},
): Promise<PaginatedResponse<PriceList>> {
  return apiClient.get<
    PaginatedResponse<PriceList>
  >(
    MASTERS_API_PATHS.PRICE_LISTS,
    {
      ...options,
      query: {
        ...paginationQuery(params),
        is_active: params.is_active,
        effective_on: params.effective_on,
      },
    },
  );
}

export async function getPriceListById(
  priceListId: UUID,
  options: MastersApiRequestOptions = {},
): Promise<PriceList> {
  return apiClient.get<PriceList>(
    resourcePath(
      MASTERS_API_PATHS.PRICE_LISTS,
      priceListId,
      "Price list ID",
    ),
    options,
  );
}

export async function createPriceList(
  request: PriceListInput,
  options: MastersApiRequestOptions = {},
): Promise<PriceList> {
  if (request.items.length === 0) {
    throw new ApiError(
      "At least one price list item is required.",
      {
        category: "validation",
        code: "EMPTY_PRICE_LIST",
      },
    );
  }

  return apiClient.post<PriceList>(
    MASTERS_API_PATHS.PRICE_LISTS,
    {
      ...request,
      name: requireText(
        request.name,
        "Price list name",
      ),
    },
    options,
  );
}

export async function updatePriceList(
  priceListId: UUID,
  request: UpdatePriceListInput,
  options: MastersApiRequestOptions = {},
): Promise<PriceList> {
  validateUpdate(request);

  if (
    request.items !== undefined &&
    request.items.length === 0
  ) {
    throw new ApiError(
      "A price list must contain at least one item.",
      {
        category: "validation",
        code: "EMPTY_PRICE_LIST",
      },
    );
  }

  return apiClient.patch<PriceList>(
    resourcePath(
      MASTERS_API_PATHS.PRICE_LISTS,
      priceListId,
      "Price list ID",
    ),
    request,
    options,
  );
}

export async function setPriceListActiveStatus(
  priceListId: UUID,
  isActive: boolean,
  options: MastersApiRequestOptions = {},
): Promise<PriceList> {
  return updatePriceList(
    priceListId,
    {
      is_active: isActive,
    },
    options,
  );
}

/* Unit Conversions */

export async function getUnitConversions(
  options: MastersApiRequestOptions = {},
): Promise<UnitConversion[]> {
  return apiClient.get<UnitConversion[]>(
    MASTERS_API_PATHS.UNIT_CONVERSIONS,
    options,
  );
}

export async function createUnitConversion(
  request: UnitConversionInput,
  options: MastersApiRequestOptions = {},
): Promise<UnitConversion> {
  if (
    request.from_unit === request.to_unit
  ) {
    throw new ApiError(
      "Source and target units must differ.",
      {
        category: "validation",
        code: "IDENTICAL_UNITS",
      },
    );
  }

  const factor =
    request.conversion_factor.trim();

  if (
    !/^\d+(?:\.\d+)?$/.test(factor) ||
    !/[1-9]/.test(factor)
  ) {
    throw new ApiError(
      "Conversion factor must be a positive decimal value.",
      {
        category: "validation",
        code: "INVALID_CONVERSION_FACTOR",
      },
    );
  }

  return apiClient.post<UnitConversion>(
    MASTERS_API_PATHS.UNIT_CONVERSIONS,
    {
      ...request,
      conversion_factor: factor,
    },
    options,
  );
}

export const mastersApi = {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  setCustomerActiveStatus,

  getSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  setSupplierActiveStatus,

  getInventoryItems,
  getInventoryItemById,
  createInventoryItem,
  updateInventoryItem,
  setInventoryItemActiveStatus,

  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  setProductActiveStatus,

  getPriceLists,
  getPriceListById,
  createPriceList,
  updatePriceList,
  setPriceListActiveStatus,

  getUnitConversions,
  createUnitConversion,
} as const;
