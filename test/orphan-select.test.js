import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCommandRejected,
  auditNowEpoch as now,
  cloudflareCreatedAt as cloudflareVersionCreatedAt,
  cloudflareInstance,
  cloudflareInstanceId,
  registryCreatedAt as registryOldCreatedAt,
  registryRow,
  runJq,
  sandboxId,
} from "./orphan-audit-harness.js";

const jqFilter = `
  include "orphan-select";
  select_orphans(
    $instances;
    $ambiguous;
    $registryRows;
    $registered;
    $now;
    $auditStart;
    $grace
  )
`;
const partitionFilter = `
  include "orphan-select";
  $instances | partition_cloudflare_instances
`;
const grace = 60;

function registryCreatedAtForAge(ageSeconds) {
  return new Date((now - ageSeconds) * 1000).toISOString();
}

function expectedOrphan({
  uuid,
  sandbox = sandboxId(uuid),
  instanceId = cloudflareInstanceId(sandbox),
  state = "running",
  ageSeconds,
  ageSource,
  registryState,
  registryCreatedAt,
  registryRevision,
  cloudflareCreated = cloudflareVersionCreatedAt,
  inactiveInstance = null,
  runnerName = uuid === null ? null : `cloudflare-${uuid}`,
  reason,
}) {
  return {
    sandboxId: sandbox,
    instanceId,
    uuid,
    state,
    ageSeconds,
    ageSource,
    registryState,
    registryCreatedAt,
    ...(registryRevision === undefined ? {} : { registryRevision }),
    cloudflareCreated,
    inactiveInstance,
    runnerName,
    reason,
  };
}

function expectedAmbiguity(variants, reason, conflictingFields) {
  const sortedVariants = [...variants].sort((left, right) => {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
  const name = variants[0].name;
  return {
    instanceId: variants[0].id,
    sandboxId: name,
    uuid: name.startsWith("runner-") ? name.slice("runner-".length) : null,
    reason,
    conflictingFields,
    variants: sortedVariants,
  };
}

function selectOrphans({
  instances,
  ambiguous = [],
  registryRows = [],
  registered = [],
  currentTime = now,
  auditStart = currentTime,
  graceSeconds = grace,
}) {
  const output = runJq(
    jqFilter,
    {
      instances,
      ambiguous,
      registryRows,
      registered,
      now: currentTime,
      auditStart,
      grace: graceSeconds,
    },
    ["-nce"],
  );

  return JSON.parse(output);
}

function assertSelectionRejected(input, messagePattern, sentinel) {
  assertCommandRejected(
    () => selectOrphans(input),
    messagePattern,
    sentinel,
  );
}

function partitionInstances(instances) {
  return JSON.parse(runJq(
    partitionFilter,
    { instances },
    ["-nce"],
  ));
}

function assertPartitionRejected(instances, messagePattern, sentinel) {
  assertCommandRejected(
    () => partitionInstances(instances),
    messagePattern,
    sentinel,
  );
}

test("collapses duplicate Cloudflare ids and sorts different ids", () => {
  const first = cloudflareInstance({
    uuid: "01111111-1111-4111-8111-111111111111",
    id: "1".repeat(64),
  });
  const second = cloudflareInstance({
    uuid: "01111111-1111-4111-8111-111111111112",
    id: "2".repeat(64),
  });

  assert.deepEqual(
    partitionInstances([second, first, { ...first }]).instances,
    [first, second],
  );
});

test("does not parse created for one Cloudflare row during collapse", () => {
  const instance = cloudflareInstance({
    uuid: "01222222-2222-4222-8222-222222222222",
    created: "not-an-rfc3339-timestamp",
  });

  assert.deepEqual(partitionInstances([instance]).instances, [instance]);
});

test("does not parse equal created values for duplicate Cloudflare rows", () => {
  const instance = cloudflareInstance({
    uuid: "01333333-3333-4333-8333-333333333333",
    created: "not-an-rfc3339-timestamp",
  });

  assert.deepEqual(
    partitionInstances([instance, { ...instance }]).instances,
    [instance],
  );
});

test("rejects differing created values when one value is malformed", () => {
  const instance = cloudflareInstance({
    uuid: "01444444-4444-4444-8444-444444444444",
  });
  const sentinel = "not-an-rfc3339-timestamp";

  assertPartitionRejected(
    [instance, { ...instance, created: sentinel }],
    /invalid RFC 3339 timestamp/,
    sentinel,
  );
});

test("keeps the earliest created value for one Cloudflare id", () => {
  const uuid = "02222222-2222-4222-8222-222222222222";
  const later = cloudflareInstance({
    uuid,
    created: "2026-08-22T10:55:30Z",
  });
  const earlier = {
    ...later,
    created: "2026-08-22T10:55:03Z",
  };

  assert.deepEqual(
    partitionInstances([earlier, later]).instances,
    [earlier],
  );
});

test("orders fractional created values numerically for one Cloudflare id", () => {
  const wholeSecond = cloudflareInstance({
    uuid: "02333333-3333-4333-8333-333333333333",
    created: "2026-08-22T10:55:30Z",
  });
  const oneHundredMilliseconds = cloudflareInstance({
    uuid: "02444444-4444-4444-8444-444444444444",
    created: "2026-08-22T10:55:30.100Z",
  });

  assert.deepEqual(
    partitionInstances([
      wholeSecond,
      { ...wholeSecond, created: "2026-08-22T10:55:30.500Z" },
    ]).instances,
    [wholeSecond],
  );
  assert.deepEqual(
    partitionInstances([
      oneHundredMilliseconds,
      { ...oneHundredMilliseconds, created: "2026-08-22T10:55:30.9Z" },
    ]).instances,
    [oneHundredMilliseconds],
  );
});

test("quarantines a case-only state conflict for one Cloudflare id", () => {
  const instance = cloudflareInstance({
    uuid: "02555555-5555-4555-8555-555555555555",
  });
  const variants = [instance, { ...instance, state: "RUNNING" }];

  assert.deepEqual(partitionInstances(variants), {
    instances: [],
    ambiguous: [expectedAmbiguity(
      variants,
      "conflicting-instance-state-case",
      ["state"],
    )],
  });
});

test("quarantines state case drift during a state transition", () => {
  const instance = cloudflareInstance({
    uuid: "02556666-6666-4666-8666-666666666666",
  });
  const variants = [
    { ...instance, state: "RUNNING" },
    { ...instance, state: "running" },
    { ...instance, state: "stopped" },
  ];

  assert.deepEqual(partitionInstances(variants), {
    instances: [],
    ambiguous: [expectedAmbiguity(
      variants,
      "conflicting-instance-state-case",
      ["state"],
    )],
  });
});

test("keeps running across a running-to-stopped page transition", () => {
  const running = cloudflareInstance({
    uuid: "02566666-6666-4666-8666-666666666666",
  });
  const stopped = { ...running, state: "stopped" };

  assert.deepEqual(
    partitionInstances([running, stopped]).instances,
    [running],
  );
  assert.deepEqual(
    partitionInstances([stopped, running]).instances,
    [running],
  );
});

test("uses the explicit liveness rank for adjacent state transitions", () => {
  const instance = cloudflareInstance({
    uuid: "02577777-7777-4777-8777-777777777777",
  });
  const transitions = [
    ["stopping", "stopped"],
    ["unknown", "inactive"],
  ];

  for (const [moreAliveState, lessAliveState] of transitions) {
    const moreAlive = { ...instance, state: moreAliveState };
    const lessAlive = { ...instance, state: lessAliveState };

    assert.deepEqual(
      partitionInstances([moreAlive, lessAlive]).instances,
      [moreAlive],
    );
    assert.deepEqual(
      partitionInstances([lessAlive, moreAlive]).instances,
      [moreAlive],
    );
  }
});

test("keeps running instead of inactive for leak detection", () => {
  const running = cloudflareInstance({
    uuid: "02588888-8888-4888-8888-888888888888",
  });

  assert.deepEqual(
    partitionInstances([running, { ...running, state: "inactive" }]).instances,
    [running],
  );
});

test("quarantines an unranked state across two rows", () => {
  const instance = cloudflareInstance({
    uuid: "02599999-9999-4999-8999-999999999999",
    state: "teleporting",
  });
  const variants = [instance, { ...instance }];

  assert.deepEqual(partitionInstances(variants), {
    instances: [],
    ambiguous: [expectedAmbiguity(
      variants,
      "unknown-instance-state",
      ["state"],
    )],
  });
});

test("keeps a single row with an unrecognized state", () => {
  const instance = cloudflareInstance({
    uuid: "02611111-1111-4111-8111-111111111111",
    state: "teleporting",
  });

  assert.deepEqual(partitionInstances([instance]).instances, [instance]);
});

test("keeps the earliest created value within the most-alive state", () => {
  const runningLater = cloudflareInstance({
    uuid: "02622222-2222-4222-8222-222222222222",
    created: "2026-08-22T10:55:30Z",
  });
  const runningEarlier = {
    ...runningLater,
    created: "2026-08-22T10:55:20Z",
  };
  const stoppedEarlier = {
    ...runningLater,
    state: "stopped",
    created: "2026-08-22T10:55:10Z",
  };

  assert.deepEqual(
    partitionInstances([
      stoppedEarlier,
      runningLater,
      runningEarlier,
    ]).instances,
    [runningEarlier],
  );
});

test("treats a missing field and an explicit null as equal", () => {
  const instance = cloudflareInstance({
    uuid: "02666666-6666-4666-8666-666666666666",
  });
  const explicitNull = { ...instance, location: null };
  const collapsed = partitionInstances([instance, explicitNull]).instances;

  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].id, instance.id);
  assert.deepEqual(
    partitionInstances([explicitNull, instance]).instances,
    collapsed,
  );
});

test("a conflicting name for one Cloudflare id rejects the partition", () => {
  const uuid = "03333333-3333-4333-8333-333333333333";
  const instance = cloudflareInstance({ uuid });
  assertPartitionRejected(
    [instance, { ...instance, name: "runner-conflicting-name" }],
    /field "name"/,
    instance.id,
  );
});

test("quarantines a location disagreement", () => {
  const instance = cloudflareInstance({
    uuid: "03444444-4444-4444-8444-444444444444",
    location: "one",
  });
  const variants = [instance, { ...instance, location: "two" }];

  assert.deepEqual(partitionInstances(variants), {
    instances: [],
    ambiguous: [expectedAmbiguity(
      variants,
      "conflicting-instance-records",
      ["location"],
    )],
  });
});

test("quarantines a version disagreement", () => {
  const instance = cloudflareInstance({
    uuid: "03455555-5555-4555-8555-555555555555",
    version: 1,
  });
  const variants = [instance, { ...instance, version: 2 }];

  assert.deepEqual(partitionInstances(variants), {
    instances: [],
    ambiguous: [expectedAmbiguity(
      variants,
      "conflicting-instance-records",
      ["version"],
    )],
  });
});

test("a location disagreement wins over state reconciliation", () => {
  const instance = cloudflareInstance({
    uuid: "03466666-6666-4666-8666-666666666666",
    location: "one",
  });
  const variants = [
    instance,
    { ...instance, state: "inactive", location: "two" },
  ];
  const partition = partitionInstances(variants);

  assert.deepEqual(partition, {
    instances: [],
    ambiguous: [expectedAmbiguity(
      variants,
      "conflicting-instance-records",
      ["location"],
    )],
  });
  assert.equal(partition.instances.some((row) => row.state === "running"), false);
});

test("lists all non-reconcilable fields in sorted order", () => {
  const instance = cloudflareInstance({
    uuid: "03477777-7777-4777-8777-777777777777",
    location: "one",
    version: 1,
  });
  const variants = [
    instance,
    { ...instance, location: "two", version: 2 },
  ];

  assert.deepEqual(partitionInstances(variants), {
    instances: [],
    ambiguous: [expectedAmbiguity(
      variants,
      "conflicting-instance-records",
      ["location", "version"],
    )],
  });
});

test("a duplicate name across two IDs rejects the partition", () => {
  const name = "runner-shared-name";
  const first = cloudflareInstance({ name, id: "1".repeat(64) });
  const second = cloudflareInstance({ name, id: "2".repeat(64) });

  assertPartitionRejected(
    [second, first],
    /duplicate Cloudflare instance name.*conflicting ids/,
    name,
  );
});

test("a quarantined record cannot hide a duplicate name", () => {
  const name = "runner-shared-quarantined-name";
  const first = cloudflareInstance({
    name,
    id: "3".repeat(64),
    location: "one",
  });
  const second = cloudflareInstance({ name, id: "4".repeat(64) });

  assertPartitionRejected(
    [first, { ...first, location: "two" }, second],
    /duplicate Cloudflare instance name.*conflicting ids/,
    name,
  );
});

test("selects a healthy orphan beside a quarantined instance", () => {
  const ambiguousInstance = cloudflareInstance({
    uuid: "03488888-8888-4888-8888-888888888888",
    location: "one",
  });
  const healthyUuid = "03499999-9999-4999-8999-999999999999";
  const healthyInstance = cloudflareInstance({ uuid: healthyUuid });
  const partition = partitionInstances([
    ambiguousInstance,
    healthyInstance,
    { ...ambiguousInstance, location: "two" },
  ]);

  assert.deepEqual(partition.instances, [healthyInstance]);
  assert.equal(partition.ambiguous.length, 1);
  assert.deepEqual(selectOrphans(partition), [expectedOrphan({
    uuid: healthyUuid,
    ageSeconds: null,
    ageSource: "unknown",
    registryState: null,
    registryCreatedAt: null,
    reason: "absent-from-registry",
  })]);
});

test("never selects a quarantined sandbox in the forward pass", () => {
  const instance = cloudflareInstance({
    uuid: "03511111-1111-4111-8111-111111111111",
  });
  const variants = [
    { ...instance, location: "one" },
    { ...instance, location: "two" },
  ];

  assert.deepEqual(selectOrphans({
    instances: [instance],
    ambiguous: [expectedAmbiguity(
      variants,
      "conflicting-instance-records",
      ["location"],
    )],
  }), []);
});

test("never reverse-reports a quarantined sandbox", () => {
  const uuid = "03522222-2222-4222-8222-222222222222";
  const instance = cloudflareInstance({ uuid, location: "one" });
  const variants = [instance, { ...instance, location: "two" }];

  assert.deepEqual(selectOrphans({
    instances: [cloudflareInstance({
      uuid: "03533333-3333-4333-8333-333333333333",
      state: "inactive",
    })],
    ambiguous: [expectedAmbiguity(
      variants,
      "conflicting-instance-records",
      ["location"],
    )],
    registryRows: [registryRow({ uuid })],
  }), []);
});

test("rejects a malformed ambiguous instance list", () => {
  const cases = [
    { records: "not-an-array" },
    [{
      sandboxId: "runner-malformed-ambiguity",
      instanceId: "5".repeat(64),
      conflictingFields: [],
    }],
  ];

  for (const malformed of cases) {
    assertSelectionRejected(
      { instances: [], ambiguous: malformed },
      /invalid ambiguous Cloudflare instance list/,
      malformed,
    );
  }
});

test("counts quarantine as Cloudflare evidence for the empty-read guard", () => {
  const uuid = "03544444-4444-4444-8444-444444444444";
  const instance = cloudflareInstance({ uuid, location: "one" });
  const variants = [instance, { ...instance, location: "two" }];

  assert.deepEqual(selectOrphans({
    instances: [],
    ambiguous: [expectedAmbiguity(
      variants,
      "conflicting-instance-records",
      ["location"],
    )],
    registryRows: [registryRow({ uuid })],
  }), []);
});

test("does not report an old nonterminal instance registered on GitHub", () => {
  const uuid = "11111111-1111-4111-8111-111111111111";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid })],
      registryRows: [registryRow({ uuid })],
      registered: [uuid],
    }),
    [],
  );
});

test("reports an unregistered instance at least as old as the grace", () => {
  const uuid = "22222222-2222-4222-8222-222222222222";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid })],
      registryRows: [registryRow({ uuid })],
    }),
    [
      expectedOrphan({
        uuid,
        ageSeconds: 130,
        ageSource: "worker-registry",
        registryState: "online",
        registryCreatedAt: registryOldCreatedAt,
        reason: "unregistered",
      }),
    ],
  );
});

test("reports an unregistered instance exactly at the grace boundary", () => {
  const uuid = "33333333-3333-4333-8333-333333333333";
  const createdAt = registryCreatedAtForAge(60);

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid })],
      registryRows: [registryRow({ uuid, createdAt })],
    }),
    [
      expectedOrphan({
        uuid,
        ageSeconds: 60,
        ageSource: "worker-registry",
        registryState: "online",
        registryCreatedAt: createdAt,
        reason: "unregistered",
      }),
    ],
  );
});

test("does not report an unregistered instance one second before the grace", () => {
  const uuid = "44444444-4444-4444-8444-444444444444";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid })],
      registryRows: [
        registryRow({ uuid, createdAt: registryCreatedAtForAge(59) }),
      ],
    }),
    [],
  );
});

test("does not report a registered instance absent from the registry", () => {
  const uuid = "55555555-5555-4555-8555-555555555555";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid })],
      registered: [uuid],
    }),
    [],
  );
});

test("reports an unregistered instance absent from the registry", () => {
  const uuid = "66666666-6666-4666-8666-666666666666";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid })],
    }),
    [
      expectedOrphan({
        uuid,
        ageSeconds: null,
        ageSource: "unknown",
        registryState: null,
        registryCreatedAt: null,
        reason: "absent-from-registry",
      }),
    ],
  );
});

test("does not slice an instance name without the expected prefix", () => {
  const name = "unexpected-instance-name";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ name })],
    }),
    [
      expectedOrphan({
        sandbox: name,
        uuid: null,
        ageSeconds: null,
        ageSource: "unknown",
        registryState: null,
        registryCreatedAt: null,
        reason: "absent-from-registry",
      }),
    ],
  );
});

test("never reports an inactive instance absent from the registry", () => {
  const uuid = "77777777-7777-4777-8777-777777777777";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid, state: "inactive" })],
    }),
    [],
  );
});

test("matches the inactive state without case sensitivity", () => {
  const uuid = "88888888-8888-4888-8888-888888888888";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid, state: "InAcTiVe" })],
    }),
    [],
  );
});

test("reports an old nonterminal registry row absent from Cloudflare", () => {
  const uuid = "89898989-8989-4989-8989-898989898989";
  const unrelatedUuid = "89898989-8989-4989-8989-898989898988";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({
        uuid: unrelatedUuid,
        state: "inactive",
      })],
      registryRows: [registryRow({ uuid, revision: 7 })],
    }),
    [
      expectedOrphan({
        uuid,
        instanceId: null,
        state: null,
        ageSeconds: 130,
        ageSource: "worker-registry",
        registryState: "online",
        registryCreatedAt: registryOldCreatedAt,
        registryRevision: 7,
        cloudflareCreated: null,
        reason: "absent-from-cloudflare",
      }),
    ],
  );
});

test("reports a registered row without a live Cloudflare instance", () => {
  const uuid = "89999999-8999-4999-8999-899999999999";
  const unrelatedUuid = "89999999-8999-4999-8999-899999999998";
  const input = {
    instances: [cloudflareInstance({
      uuid: unrelatedUuid,
      state: "inactive",
    })],
    registryRows: [registryRow({ uuid, revision: 7 })],
  };

  assert.deepEqual(
    selectOrphans({ ...input, registered: [uuid] }),
    [{
      ...expectedOrphan({
        uuid,
        instanceId: null,
        state: null,
        ageSeconds: 130,
        ageSource: "worker-registry",
        registryState: "online",
        registryCreatedAt: registryOldCreatedAt,
        registryRevision: 7,
        cloudflareCreated: null,
        reason: "registered-without-instance",
      }),
      runnerName: `cloudflare-${uuid}`,
    }],
  );
});

test("resolves the runner name for every orphan class", () => {
  const uuid = "89aaaaaa-89aa-49aa-89aa-89aa89aa89aa";
  const unrelatedUuid = "89bbbbbb-89bb-49bb-89bb-89bb89bb89bb";
  const authoritativeName = "cloudflare-1-4503599627370518";
  const inactiveEvidence = [cloudflareInstance({
    uuid: unrelatedUuid,
    state: "inactive",
  })];
  const cases = [
    {
      reason: "unregistered",
      expectedName: authoritativeName,
      input: {
        instances: [cloudflareInstance({ uuid })],
        registryRows: [registryRow({ uuid, githubRunnerName: authoritativeName })],
      },
    },
    {
      reason: "terminal-registry-row",
      expectedName: authoritativeName,
      input: {
        instances: [cloudflareInstance({ uuid })],
        registryRows: [registryRow({
          uuid,
          state: "destroyed",
          githubRunnerName: authoritativeName,
        })],
      },
    },
    {
      reason: "absent-from-registry",
      expectedName: `cloudflare-${uuid}`,
      input: { instances: [cloudflareInstance({ uuid })] },
    },
    {
      reason: "absent-from-cloudflare",
      expectedName: authoritativeName,
      input: {
        instances: inactiveEvidence,
        registryRows: [registryRow({ uuid, githubRunnerName: authoritativeName })],
      },
    },
    {
      reason: "registered-without-instance",
      expectedName: authoritativeName,
      input: {
        instances: inactiveEvidence,
        registryRows: [registryRow({ uuid, githubRunnerName: authoritativeName })],
        registered: [uuid],
      },
    },
  ];

  for (const testCase of cases) {
    const orphans = selectOrphans(testCase.input);

    assert.equal(orphans.length, 1, testCase.reason);
    assert.equal(orphans[0].reason, testCase.reason);
    assert.equal(orphans[0].runnerName, testCase.expectedName);
  }
});

test("falls back to the UUID-derived name for a legacy registry row", () => {
  const uuid = "89cccccc-89cc-49cc-89cc-89cc89cc89cc";
  const orphans = selectOrphans({
    instances: [cloudflareInstance({ uuid })],
    registryRows: [registryRow({ uuid })],
  });

  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].runnerName, `cloudflare-${uuid}`);
});

test("keeps the same unregistered row absent from Cloudflare unchanged", () => {
  const uuid = "89999999-8999-4999-8999-899999999999";
  const unrelatedUuid = "89999999-8999-4999-8999-899999999998";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({
        uuid: unrelatedUuid,
        state: "inactive",
      })],
      registryRows: [registryRow({ uuid, revision: 7 })],
    }),
    [
      expectedOrphan({
        uuid,
        instanceId: null,
        state: null,
        ageSeconds: 130,
        ageSource: "worker-registry",
        registryState: "online",
        registryCreatedAt: registryOldCreatedAt,
        registryRevision: 7,
        cloudflareCreated: null,
        reason: "absent-from-cloudflare",
      }),
    ],
  );
});

test("does not report a registry row absent from Cloudflare inside the grace", () => {
  const uuid = "8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a";

  assert.deepEqual(
    selectOrphans({
      instances: [],
      registryRows: [registryRow({
        uuid,
        createdAt: registryCreatedAtForAge(59),
      })],
    }),
    [],
  );
});

test("does not report a young registered row before its instance starts", () => {
  const uuid = "8a9a9a9a-8a9a-4a9a-8a9a-8a9a8a9a8a9a";

  assert.deepEqual(
    selectOrphans({
      instances: [],
      registryRows: [registryRow({
        uuid,
        createdAt: registryCreatedAtForAge(grace - 1),
      })],
      registered: [uuid],
    }),
    [],
  );
});

test("does not report a destroyed registry row absent from Cloudflare", () => {
  const uuid = "8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b";

  assert.deepEqual(
    selectOrphans({
      instances: [],
      registryRows: [registryRow({ uuid, state: "destroyed" })],
    }),
    [],
  );
});

test("does not report a registered terminal row without an instance", () => {
  const uuid = "8b9b9b9b-8b9b-4b9b-8b9b-8b9b8b9b8b9b";

  assert.deepEqual(
    selectOrphans({
      instances: [],
      registryRows: [registryRow({ uuid, state: "destroyed" })],
      registered: [uuid],
    }),
    [],
  );
});

test("does not reverse-report a registry row with a running instance", () => {
  const uuid = "8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid })],
      registryRows: [registryRow({ uuid })],
      registered: [uuid],
    }),
    [],
  );
});

test("does not report a registered row quarantined as ambiguous", () => {
  const uuid = "8c9c9c9c-8c9c-4c9c-8c9c-8c9c8c9c8c9c";
  const instance = cloudflareInstance({ uuid, location: "one" });
  const variants = [instance, { ...instance, location: "two" }];

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({
        uuid: "8c9c9c9c-8c9c-4c9c-8c9c-8c9c8c9c8c9b",
        state: "inactive",
      })],
      ambiguous: [expectedAmbiguity(
        variants,
        "conflicting-instance-records",
        ["location"],
      )],
      registryRows: [registryRow({ uuid })],
      registered: [uuid],
    }),
    [],
  );
});

test("uses the grace boundary for a registered row without an instance", () => {
  const uuid = "8caaaaaa-8caa-4caa-8caa-8caa8caa8caa";
  const unrelatedUuid = "8cbbbbbb-8cbb-4cbb-8cbb-8cbb8cbb8cbb";
  const instances = [cloudflareInstance({
    uuid: unrelatedUuid,
    state: "inactive",
  })];
  const createdAtBoundary = registryCreatedAtForAge(grace);

  assert.deepEqual(
    selectOrphans({
      instances,
      registryRows: [registryRow({ uuid, createdAt: createdAtBoundary })],
      registered: [uuid],
    }),
    [{
      ...expectedOrphan({
        uuid,
        instanceId: null,
        state: null,
        ageSeconds: grace,
        ageSource: "worker-registry",
        registryState: "online",
        registryCreatedAt: createdAtBoundary,
        registryRevision: 0,
        cloudflareCreated: null,
        reason: "registered-without-instance",
      }),
      runnerName: `cloudflare-${uuid}`,
    }],
  );
  assert.deepEqual(
    selectOrphans({
      instances,
      registryRows: [registryRow({
        uuid,
        createdAt: registryCreatedAtForAge(grace - 1),
      })],
      registered: [uuid],
    }),
    [],
  );
});

test("reports a registry row whose only Cloudflare instance is inactive", () => {
  const uuid = "8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d";
  const instance = cloudflareInstance({ uuid, state: "inactive" });

  assert.deepEqual(
    selectOrphans({
      instances: [instance],
      registryRows: [registryRow({ uuid })],
    }),
    [
      expectedOrphan({
        uuid,
        instanceId: null,
        state: null,
        ageSeconds: 130,
        ageSource: "worker-registry",
        registryState: "online",
        registryCreatedAt: registryOldCreatedAt,
        registryRevision: 0,
        cloudflareCreated: null,
        inactiveInstance: {
          id: instance.id,
          state: instance.state,
          created: instance.created,
        },
        reason: "absent-from-cloudflare",
      }),
    ],
  );
});

test("the reverse pass never duplicates a forward-pass record", () => {
  const uuid = "8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e";
  const orphans = selectOrphans({
    instances: [cloudflareInstance({ uuid })],
    registryRows: [registryRow({ uuid })],
  });

  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].reason, "unregistered");
});

test("rejects an empty Cloudflare read with an old online registry row", () => {
  const uuid = "8f8f8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8f";

  assertSelectionRejected(
    {
      instances: [],
      registryRows: [registryRow({ uuid })],
    },
    /Cloudflare reported no container instances while the Worker registry holds 1 starting or online row\(s\) older than the grace period/,
    1,
  );
});

test("reports an old destroying row from an empty Cloudflare read", () => {
  const uuid = "8f8f8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8e";

  assert.deepEqual(
    selectOrphans({
      instances: [],
      registryRows: [registryRow({ uuid, state: "destroying" })],
    }),
    [
      expectedOrphan({
        uuid,
        instanceId: null,
        state: null,
        ageSeconds: 130,
        ageSource: "worker-registry",
        registryState: "destroying",
        registryCreatedAt: registryOldCreatedAt,
        registryRevision: 0,
        cloudflareCreated: null,
        reason: "absent-from-cloudflare",
      }),
    ],
  );
});

test("does not reverse-report a row that crosses the grace after audit start", () => {
  const uuid = "8f8f8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8d";
  const createdAt = registryCreatedAtForAge(61);

  assert.deepEqual(
    selectOrphans({
      instances: [],
      registryRows: [registryRow({ uuid, createdAt })],
      auditStart: now - 2,
    }),
    [],
  );
});

test("accepts an empty Cloudflare read with no old nonterminal registry row", () => {
  const destroyedUuid = "90909090-9090-4090-8090-909090909090";
  const recentUuid = "91919191-9191-4191-8191-919191919191";

  for (const registryRows of [
    [registryRow({ uuid: destroyedUuid, state: "destroyed" })],
    [registryRow({
      uuid: recentUuid,
      createdAt: registryCreatedAtForAge(59),
    })],
  ]) {
    assert.deepEqual(selectOrphans({ instances: [], registryRows }), []);
  }
});

test("reports an old terminal registry row despite GitHub registration", () => {
  const uuid = "99999999-9999-4999-8999-999999999999";
  const orphans = selectOrphans({
    instances: [cloudflareInstance({ uuid })],
    registryRows: [registryRow({ uuid, state: "destroyed", revision: 4 })],
    registered: [uuid],
  });

  assert.equal(orphans.length, 1);
  assert.deepEqual(orphans[0], expectedOrphan({
    uuid,
    ageSeconds: 130,
    ageSource: "worker-registry",
    registryState: "destroyed",
    registryCreatedAt: registryOldCreatedAt,
    reason: "terminal-registry-row",
  }));
});

test("emits the instance identifier for every orphan class", () => {
  const unregisteredUuid = "a1111111-1111-4111-8111-111111111111";
  const absentUuid = "a2222222-2222-4222-8222-222222222222";
  const terminalUuid = "a3333333-3333-4333-8333-333333333333";
  const instances = [unregisteredUuid, absentUuid, terminalUuid].map((uuid) =>
    cloudflareInstance({ uuid }));

  const orphans = selectOrphans({
    instances,
    registryRows: [
      registryRow({ uuid: unregisteredUuid }),
      registryRow({ uuid: terminalUuid, state: "destroyed" }),
    ],
  });

  assert.deepEqual(
    Object.fromEntries(orphans.map((orphan) => [orphan.reason, orphan.instanceId])),
    {
      unregistered: instances[0].id,
      "absent-from-registry": instances[1].id,
      "terminal-registry-row": instances[2].id,
    },
  );
});

test("keeps the highest revision when cursor movement repeats a row", () => {
  const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid })],
      registryRows: [
        registryRow({ uuid, state: "destroyed", revision: 2 }),
        registryRow({ uuid, state: "online", revision: 3 }),
      ],
      registered: [uuid],
    }),
    [],
  );
});

test("accepts identical repeated rows with equal revisions", () => {
  const uuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const row = registryRow({ uuid, revision: 3 });

  assert.deepEqual(
    selectOrphans({
      instances: [cloudflareInstance({ uuid })],
      registryRows: [row, { ...row }],
      registered: [uuid],
    }),
    [],
  );
});

test("rejects conflicting repeated rows with equal revisions in either order", () => {
  const uuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const online = registryRow({ uuid, state: "online", revision: 3 });
  const destroyed = registryRow({ uuid, state: "destroyed", revision: 3 });

  for (const registryRows of [
    [online, destroyed],
    [destroyed, online],
  ]) {
    assertSelectionRejected(
      {
        instances: [cloudflareInstance({ uuid })],
        registryRows,
        registered: [uuid],
      },
      /conflicting Worker registry records/,
      sandboxId(uuid),
    );
  }
});

test("rejects a missing, non-numeric, or negative registry revision", () => {
  const uuid = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";

  for (const revision of [undefined, "1", -1]) {
    const row = registryRow({ uuid, revision });
    assertSelectionRejected(
      {
        instances: [cloudflareInstance({ uuid })],
        registryRows: [row],
      },
      /invalid Worker registry record/,
      row.sandboxId,
    );
  }
});

test("rejects an unknown registry state", () => {
  const uuid = "cececece-cece-4ece-8ece-cececececece";

  assertSelectionRejected(
    {
      instances: [cloudflareInstance({ uuid })],
      registryRows: [registryRow({ uuid, state: "paused" })],
    },
    /invalid Worker registry record/,
    "paused",
  );
});

test("rejects non-string Cloudflare instance fields", () => {
  const uuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  for (const [field, value] of [
    ["name", 42],
    ["state", null],
    ["created", { timestamp: cloudflareVersionCreatedAt }],
  ]) {
    assertSelectionRejected(
      {
        instances: [
          {
            ...cloudflareInstance({ uuid }),
            [field]: value,
          },
        ],
      },
      /invalid Cloudflare instance record/,
      value,
    );
  }
});

test("rejects a missing or malformed Cloudflare instance identifier", () => {
  const uuid = "dededede-dede-4ded-8ded-dededededede";
  const missingId = cloudflareInstance({ uuid });
  delete missingId.id;
  const cases = [
    { instance: missingId, sentinel: sandboxId(uuid) },
    { id: 42, sentinel: 42 },
    { id: "a".repeat(63), sentinel: "a".repeat(63) },
    { id: "a".repeat(65), sentinel: "a".repeat(65) },
    { id: "A".repeat(64), sentinel: "A".repeat(64) },
    { id: `${"a".repeat(63)}g`, sentinel: `${"a".repeat(63)}g` },
  ];

  for (const testCase of cases) {
    const instance = testCase.instance ?? cloudflareInstance({
      uuid,
      id: testCase.id,
    });
    assertSelectionRejected(
      { instances: [instance] },
      /invalid Cloudflare instance record/,
      testCase.sentinel,
    );
  }
});

test("rejects non-string Worker registry fields", () => {
  const uuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  for (const [field, value] of [
    ["sandboxId", 42],
    ["state", null],
    ["createdAt", { timestamp: registryOldCreatedAt }],
  ]) {
    assertSelectionRejected(
      {
        instances: [cloudflareInstance({ uuid })],
        registryRows: [
          {
            ...registryRow({ uuid }),
            [field]: value,
          },
        ],
      },
      /invalid Worker registry record/,
      value,
    );
  }
});

test("rejects an empty or non-string GitHub runner name", () => {
  const uuid = "efefefef-efef-4fef-8fef-efefefefefef";

  for (const githubRunnerName of [42, ""]) {
    assertSelectionRejected(
      {
        instances: [cloudflareInstance({ uuid })],
        registryRows: [registryRow({ uuid, githubRunnerName })],
      },
      /invalid Worker registry record/,
      githubRunnerName,
    );
  }
});

test("rejects non-array audit lists", () => {
  assertSelectionRejected(
    { instances: { name: "not-an-array" } },
    /invalid Cloudflare instance list/,
    { name: "not-an-array" },
  );
  assertSelectionRejected(
    { instances: [], registryRows: { runners: [] } },
    /invalid Worker registry row list/,
    { runners: [] },
  );
  assertSelectionRejected(
    { instances: [], registered: { runners: [] } },
    /invalid registered GitHub UUID list/,
    { runners: [] },
  );
});

test("rejects a non-string registered GitHub UUID", () => {
  assertSelectionRejected(
    { instances: [], registered: [42] },
    /invalid registered GitHub UUID list/,
    42,
  );
});

test("rejects an invalid audit time and names it", () => {
  assertSelectionRejected(
    { instances: [], currentTime: "invalid-audit-time" },
    /invalid audit time/,
    "invalid-audit-time",
  );
});

test("rejects a malformed Cloudflare timestamp and names it", () => {
  const uuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const sentinel = "instance-timestamp-sentinel";

  assertSelectionRejected(
    {
      instances: [cloudflareInstance({ uuid, created: sentinel })],
    },
    /invalid RFC 3339 timestamp/,
    sentinel,
  );
});

test("rejects a malformed registry timestamp and names it", () => {
  const uuid = "01234567-89ab-4cde-8fab-0123456789ab";
  const sentinel = "registry-timestamp-sentinel";

  assertSelectionRejected(
    {
      instances: [cloudflareInstance({ uuid })],
      registryRows: [registryRow({ uuid, createdAt: sentinel })],
    },
    /invalid RFC 3339 timestamp/,
    sentinel,
  );
});

test("ignores an unmatched destroyed row with a future timestamp", () => {
  const uuid = "10234567-89ab-4cde-8fab-0123456789ab";
  const createdAt = new Date((now + 1) * 1000).toISOString();

  assert.deepEqual(selectOrphans({
    instances: [],
    registryRows: [registryRow({ uuid, state: "destroyed", createdAt })],
  }), []);
});

test("rejects a future online registry timestamp", () => {
  const uuid = "11234567-89ab-4cde-8fab-0123456789ab";
  const createdAt = new Date((now + 1) * 1000).toISOString();

  assertSelectionRejected(
    {
      instances: [],
      registryRows: [registryRow({ uuid, createdAt })],
    },
    /registry timestamp is later than the audit time/,
    createdAt,
  );
});

test("rejects a future destroyed row joined to a live instance", () => {
  const uuid = "12234567-89ab-4cde-8fab-0123456789ab";
  const createdAt = new Date((now + 1) * 1000).toISOString();

  assertSelectionRejected(
    {
      instances: [cloudflareInstance({ uuid })],
      registryRows: [registryRow({ uuid, state: "destroyed", createdAt })],
    },
    /registry timestamp is later than the audit time/,
    createdAt,
  );
});
