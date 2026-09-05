/*
 * unstable_dev can fail before a request reaches the Worker. Miniflare returns
 * a 500 "Network connection lost" response, or undici rejects with
 * TypeError: fetch failed. This guard names that harness failure and
 * deliberately does not retry the request.
 */

const LOST_CONNECTION_DETAIL = "Network connection lost";

export class DevWorkerTransportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DevWorkerTransportError";
  }
}

function describeRequest(input, init) {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const target = input instanceof Request ? input.url : String(input);
  return `${method.toUpperCase()} ${target}`;
}

function describeRejection(error) {
  const detail = `${error.name}: ${error.message}`;
  if (error.cause === undefined) {
    return detail;
  }
  const cause = error.cause instanceof Error
    ? `${error.cause.name}: ${error.cause.message}`
    : String(error.cause);
  return `${detail}; cause: ${cause}`;
}

function transportFailure(request, detail, cause) {
  const message =
    `miniflare unstable_dev transport failure for ${request} — ` +
    "the request never reached the Worker under test, so this is a harness " +
    `failure, not a product failure: ${detail}`;
  const options = cause === undefined ? undefined : { cause };
  return new DevWorkerTransportError(message, options);
}

export function guardDevWorkerTransport(worker) {
  const originalFetch = worker.fetch;

  worker.fetch = async (...args) => {
    const request = describeRequest(args[0], args[1]);
    let response;

    try {
      response = await Reflect.apply(originalFetch, worker, args);
    } catch (error) {
      if (error instanceof TypeError && error.message === "fetch failed") {
        throw transportFailure(request, describeRejection(error), error);
      }
      throw error;
    }

    if (response.status === 500) {
      const detail = await response.clone().text();
      if (detail.includes(LOST_CONNECTION_DETAIL)) {
        throw transportFailure(request, detail);
      }
    }

    return response;
  };

  return worker;
}
