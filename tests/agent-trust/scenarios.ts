import { answerScenarios } from "./answer-scenarios";
import { loopScenarios } from "./loop-scenarios";
import { memoryScenarios } from "./memory-scenarios";

export const trustScenarios = [
  ...loopScenarios,
  ...memoryScenarios,
  ...answerScenarios,
];
