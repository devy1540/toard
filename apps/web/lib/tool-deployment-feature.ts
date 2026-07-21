export function toolDeploymentExperimentalEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.TOARD_TOOL_DEPLOYMENT_EXPERIMENTAL === "1";
}

export function toolDeploymentUnavailableResponse(): Response {
  return Response.json(
    { error: "tool_deployment_experimental_disabled" },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}
