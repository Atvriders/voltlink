// Global step-up bridge (guide 07 §2.6): the API client asks for step-up when a
// command returns 403 STEP_UP_REQUIRED, and StepUpDialog answers the request.

export type StepUpHandler = (methods: string[]) => Promise<boolean>;

let handler: StepUpHandler | null = null;

export function setStepUpHandler(h: StepUpHandler | null): void {
  handler = h;
}

export async function requestStepUp(methods: string[]): Promise<boolean> {
  if (!handler) return false;
  return handler(methods);
}
