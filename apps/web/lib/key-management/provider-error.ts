import type { KeyProviderName } from "./types";

type ProviderErrorBrand = Readonly<{
  provider: KeyProviderName;
  code: string;
}>;

const providerErrorBrands = new WeakMap<object, ProviderErrorBrand>();

export function providerError(
  provider: KeyProviderName,
  code: string,
): Error {
  const error = new Error(`${provider}:${code}`);
  providerErrorBrands.set(error, Object.freeze({ provider, code }));
  return error;
}

export function inspectProviderError(
  error: unknown,
  expectedProvider: KeyProviderName,
  allowedCodes: ReadonlySet<string>,
): string | null {
  if (
    (typeof error !== "object" || error === null)
    && typeof error !== "function"
  ) {
    return null;
  }
  try {
    const brand = providerErrorBrands.get(error as object);
    if (
      !brand
      || brand.provider !== expectedProvider
      || !allowedCodes.has(brand.code)
    ) {
      return null;
    }
    return brand.code;
  } catch {
    return null;
  }
}
