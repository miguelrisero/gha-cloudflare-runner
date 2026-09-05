const cloudflareWorkersStub =
  "data:text/javascript,export class DurableObject {}";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { shortCircuit: true, url: cloudflareWorkersStub };
  }
  return nextResolve(specifier, context);
}
