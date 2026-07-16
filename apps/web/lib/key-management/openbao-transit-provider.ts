import {
  TransitKeyManagementProvider,
  type TransitProviderInput,
} from "./vault-transit-provider";

export class OpenBaoTransitProvider extends TransitKeyManagementProvider {
  readonly name = "openbao-transit" as const;

  constructor(input: TransitProviderInput) {
    super("openbao-transit", input);
  }
}
