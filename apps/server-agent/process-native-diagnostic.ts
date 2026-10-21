import {
  NATIVE_TEST_DIAGNOSTIC_CODES,
  NativeTestDiagnosticSchema,
  type NativeTestDiagnostic,
  type NativeTestDiagnosticCode,
  type NativeTestDiagnosticEvidence,
} from "../../packages/protocol/process-native-testing";

/** Private typed failure; Mastra's serialized error text is never diagnostic evidence. */
export class NativeTestDiagnosticError extends Error {
  diagnostic: NativeTestDiagnostic;
  constructor(
    code: NativeTestDiagnosticCode,
    evidence?: NativeTestDiagnosticEvidence,
  ) {
    super(code);
    const [category, phase] = NATIVE_TEST_DIAGNOSTIC_CODES[code];
    this.diagnostic = NativeTestDiagnosticSchema.parse({
      category,
      code,
      phase,
      ...(evidence ? { evidence } : {}),
      secondaryCodes: [],
    });
  }
  secondary(code: NativeTestDiagnosticCode) {
    if (
      code !== this.diagnostic.code &&
      !this.diagnostic.secondaryCodes.includes(code) &&
      this.diagnostic.secondaryCodes.length < 4
    )
      this.diagnostic.secondaryCodes.push(code);
    return this;
  }
}
