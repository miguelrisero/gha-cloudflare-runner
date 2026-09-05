import { OutageGate } from "./gate.js";

export { OutageGate };

async function fetch(request, env) {
  const id = env.OutageGate.idFromName("singleton");
  return env.OutageGate.get(id).fetch(request);
}

export default { fetch };
