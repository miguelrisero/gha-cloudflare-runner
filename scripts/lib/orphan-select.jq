include "rfc3339";

def cloudflare_instance_name_prefix: "runner-";

# This prefix is only a fallback for a sandbox with no authoritative GitHub
# runner name in the Worker registry.
def github_runner_name_prefix: "cloudflare-";

def authoritative_runner_name($row; $uuid):
  if (
    $row != null and
    ($row.githubRunnerName? | type) == "string" and
    ($row.githubRunnerName | length) > 0
  ) then
    $row.githubRunnerName
  elif $uuid != null then
    github_runner_name_prefix + $uuid
  else
    null
  end;

def sandbox_uuid:
  if startswith(cloudflare_instance_name_prefix) then
    ltrimstr(cloudflare_instance_name_prefix)
  else
    null
  end;

def is_non_negative_integer:
  type == "number" and floor == . and . >= 0;

def is_registry_state:
  . == "starting" or
  . == "online" or
  . == "destroying" or
  . == "destroyed";

def is_non_terminal_registry_state:
  . == "starting" or . == "online" or . == "destroying";

def is_blind_read_registry_state:
  . == "starting" or . == "online";

def validate_cloudflare_instance:
  if (
    type == "object" and
    (if (.id | type) == "string" then
      (.id | test("^[0-9a-f]{64}$"))
    else
      false
    end) and
    (.name | type) == "string" and
    (.state | type) == "string" and
    (.created | type) == "string"
  ) then
    .
  else
    error("invalid Cloudflare instance record: \(. | tojson)")
  end;

def cloudflare_instance_field_differs($instances; $field):
  ([$instances[] | .[$field]] | unique | length) > 1;

def cloudflare_instance_conflicting_fields($instances):
  [
    $instances[]
    | keys[]
    | select(. != "created" and . != "name" and . != "state")
  ]
  | unique
  | [
      .[] as $field
      | select(cloudflare_instance_field_differs($instances; $field))
      | $field
    ]
  | sort
  | unique;

# Cloudflare defines the status.state enum for the API endpoint
# GET /accounts/{account_id}/containers/applications/{application_id}/instances:
# provisioning, running, failed, stopping, stopped, unhealthy, inactive, and
# unknown. The rest of the audit treats only inactive as not live. Unknown ranks
# just above it because Cloudflare cannot report a state, so any concrete live
# state wins the label. Rank the values from least alive to most alive.
def cloudflare_instance_state_rank:
  ascii_downcase as $state
  | ({
      "inactive": 0,
      "unknown": 1,
      "stopped": 2,
      "failed": 3,
      "unhealthy": 4,
      "stopping": 5,
      "provisioning": 6,
      "running": 7
    })[$state];

def rfc3339_fraction_digits:
  (
    capture(
      "\\.(?<fraction>[0-9]+)(?:[Zz]|[+-][0-9]{2}:[0-9]{2})$"
    )? // {fraction: ""}
  ).fraction;

def cloudflare_instance_ambiguity($instances; $reason; $fields):
  {
    instanceId: $instances[0].id,
    sandboxId: $instances[0].name,
    uuid: ($instances[0].name | sandbox_uuid),
    reason: $reason,
    conflictingFields: $fields,
    variants: ($instances | sort_by(tojson))
  };

def select_earliest_cloudflare_instance($instances):
  if ($instances | length) == 1 then
    $instances[0]
  elif ([$instances[].created] | unique | length) == 1 then
    $instances | min_by(tojson)
  else
    # A 2026-08-22 live read found three IDs with changing creation times.
    # The audit does not use this field for age. Keep the earliest evidence.
    (
      $instances
      | map(.created | rfc3339_fraction_digits | length)
      | max
    ) as $fraction_width
    | $instances
    | min_by([
        (.created | rfc3339_to_epoch),
        (
          (.created | rfc3339_fraction_digits) as $fraction
          # Equal-width digit strings have numeric order.
          | $fraction + (
              "0" * ($fraction_width - ($fraction | length))
            )
        ),
        tojson
      ])
  end;

def partition_cloudflare_instances:
  if type != "array" then
    error("invalid Cloudflare instance list: \(. | tojson)")
  else
    map(validate_cloudflare_instance) as $validated_instances
    | (
        $validated_instances
        | group_by(.id)
        | map(select([.[].name] | unique | length > 1))
        | .[0] // null
      ) as $id_name_conflict
    | if $id_name_conflict != null then
        error(
          "conflicting Cloudflare instance records for id " +
          "\($id_name_conflict[0].id | tojson): field \("name" | tojson)"
        )
      else
        $validated_instances
      end
    | . as $name_validated_instances
    | (
        $name_validated_instances
        | group_by(.name)
        | map(
            . as $named_instances
            | ($named_instances | map(.id) | unique) as $ids
            | select(($ids | length) > 1)
            | {name: $named_instances[0].name, ids: $ids}
          )
        | .[0] // null
      ) as $name_conflict
    | if $name_conflict != null then
        error(
          "duplicate Cloudflare instance name " +
          "\($name_conflict.name | tojson) has conflicting ids " +
          "\($name_conflict.ids | sort | tojson)"
        )
      else
        $name_validated_instances
      end
    | group_by(.id)
    | map(
        . as $instances
        | if ($instances | length) == 1 then
            {instance: $instances[0]}
          else
            cloudflare_instance_conflicting_fields($instances) as $fields
            | ([$instances[].state] | unique) as $states
            | if ($fields | length) > 0 then
                {
                  ambiguous: cloudflare_instance_ambiguity(
                    $instances;
                    "conflicting-instance-records";
                    $fields
                  )
                }
              elif (
                $states
                | group_by(ascii_downcase)
                | any(length > 1)
              ) then
                {
                  ambiguous: cloudflare_instance_ambiguity(
                    $instances;
                    "conflicting-instance-state-case";
                    ["state"]
                  )
                }
              else
                (
                  $instances
                  | map(
                      . as $instance
                      | (
                          $instance.state
                          | cloudflare_instance_state_rank
                        ) as $rank
                      | {instance: $instance, rank: $rank}
                    )
                ) as $ranked_instances
                | if any($ranked_instances[]; .rank == null) then
                    {
                      ambiguous: cloudflare_instance_ambiguity(
                        $instances;
                        "unknown-instance-state";
                        ["state"]
                      )
                    }
                  else
                    # A non-atomic read can observe one lifecycle transition.
                    # Keep the most-alive state so a stale row cannot hide a leak.
                    ($ranked_instances | map(.rank) | max) as $max_rank
                    | [
                        $ranked_instances[]
                        | select(.rank == $max_rank)
                        | .instance
                      ]
                    | {instance: select_earliest_cloudflare_instance(.)}
                  end
              end
          end
      )
    | {
        instances: [
          .[]
          | select(has("instance"))
          | .instance
        ],
        ambiguous: (
          [
            .[]
            | select(has("ambiguous"))
            | .ambiguous
          ]
          | sort_by(.sandboxId)
        )
      }
  end;

def validate_registry_row:
  if (
    type == "object" and
    (.sandboxId | type) == "string" and
    (.state | type) == "string" and
    (.state | is_registry_state) and
    (.createdAt | type) == "string" and
    (.revision | is_non_negative_integer) and
    (
      (has("githubRunnerName") | not) or
      .githubRunnerName == null or
      (
        (.githubRunnerName | type) == "string" and
        (.githubRunnerName | length) > 0
      )
    )
  ) then
    {row: ., createdEpoch: (.createdAt | rfc3339_to_epoch)}
  else
    error("invalid Worker registry record: \(. | tojson)")
  end;

def registry_entries_by_sandbox($entries):
  # A state change can move one row between cursor partitions during an audit.
  # Keep the highest revision. Equal revisions must contain identical rows.
  reduce $entries[] as $entry
    ({};
      .[$entry.row.sandboxId] as $existing
      | if $existing == null or $entry.row.revision > $existing.row.revision then
          .[$entry.row.sandboxId] = $entry
        elif $entry.row.revision < $existing.row.revision then
          .
        elif $entry.row == $existing.row then
          .
        else
          error(
            "conflicting Worker registry records for " +
            "\($entry.row.sandboxId | tojson) at revision " +
            "\($entry.row.revision)"
          )
        end
    );

def cloudflare_instances_by_name($instances):
  reduce $instances[] as $instance
    ({};
      ($instance.state | ascii_downcase) as $state
      | .[$instance.name] as $existing
      | .[$instance.name] = {
          hasLiveInstance: (
            ($existing.hasLiveInstance // false) or $state != "inactive"
          ),
          inactiveInstance: (
            if $existing.inactiveInstance != null then
              $existing.inactiveInstance
            elif $state == "inactive" then
              $instance
            else
              null
            end
          )
        }
    );

def registry_entry_with_age($entry; $now):
  ($now - $entry.createdEpoch) as $age
  | if $age < 0 then
      error(
        "Worker registry timestamp is later than the audit time: " +
        "\($entry.row.createdAt | tojson)"
      )
    else
      $entry + {ageSeconds: $age}
    end;

def select_orphans(
  $instances;
  $ambiguous;
  $registry_rows;
  $registered;
  $now;
  $audit_start;
  $grace
):
  if ($instances | type) != "array" then
    error("invalid Cloudflare instance list: \($instances | tojson)")
  elif ($ambiguous | type) != "array" then
    error("invalid ambiguous Cloudflare instance list: \($ambiguous | tojson)")
  elif any(
    $ambiguous[];
    type != "object" or
    (.sandboxId | type) != "string" or
    (.instanceId | type) != "string" or
    (.conflictingFields | type) != "array" or
    (.conflictingFields | length) == 0
  ) then
    error("invalid ambiguous Cloudflare instance list: \($ambiguous | tojson)")
  elif ($registry_rows | type) != "array" then
    error("invalid Worker registry row list: \($registry_rows | tojson)")
  elif (
    ($registered | type) != "array" or
    any($registered[]; type != "string")
  ) then
    error("invalid registered GitHub UUID list: \($registered | tojson)")
  elif ($now | is_non_negative_integer | not) then
    error("invalid audit time: \($now | tojson)")
  elif ($audit_start | is_non_negative_integer | not) then
    error("invalid audit start time: \($audit_start | tojson)")
  else
    ($instances | map(validate_cloudflare_instance)) as $validated_instances
    | cloudflare_instances_by_name($validated_instances) as $instances_by_name
    | ($ambiguous | map(.sandboxId) | INDEX(.)) as $ambiguous_by_sandbox
    | ($registered | INDEX(.)) as $registered_by_uuid
    | ($registry_rows | map(validate_registry_row)) as $validated_registry_entries
    | registry_entries_by_sandbox($validated_registry_entries) as $registry_by_sandbox
    | (
        $registry_by_sandbox
        | to_entries
        | map(
            .value
            | select(.row.state | is_non_terminal_registry_state)
            | . as $entry
            | registry_entry_with_age($entry; $now)
          )
      ) as $registry_entries
    | [
        $registry_entries[]
        # A destroying row can normally outlive its Cloudflare instance. Exclude
        # it from this error, but keep it in the reverse-pass finding below.
        | select(.row.state | is_blind_read_registry_state)
        | select(($audit_start - .createdEpoch) >= $grace)
      ] as $old_blind_read_registry_entries
    # Cloudflare is read before the registry. A row inside the grace can be
    # created between those snapshots and can legitimately lack an instance.
    | if (
        ($validated_instances | length) == 0 and
        ($ambiguous | length) == 0 and
        ($old_blind_read_registry_entries | length) > 0
      ) then
        error(
          "Cloudflare reported no container instances while the Worker " +
          "registry holds \($old_blind_read_registry_entries | length) " +
          "starting or online row(s) older than the grace period"
        )
      else
        [
          (
            $validated_instances[]
            | select($ambiguous_by_sandbox[.name] == null)
            | select((.state | ascii_downcase) != "inactive")
            | . as $instance
            # Validate Cloudflare's timestamp, but never use it for age.
            | ($instance.created | rfc3339_to_epoch) as $_cloudflare_created_epoch
            | ($instance.name | sandbox_uuid) as $uuid
            | ($registry_by_sandbox[$instance.name] // null) as $raw_registry_entry
            | (
                if $raw_registry_entry == null then
                  null
                else
                  registry_entry_with_age($raw_registry_entry; $now)
                end
              ) as $registry_entry
            | (
                $uuid != null and
                $registered_by_uuid[$uuid] != null
              ) as $is_registered
            | {
                sandboxId: $instance.name,
                instanceId: $instance.id,
                uuid: $uuid,
                state: $instance.state,
                ageSeconds: $registry_entry.ageSeconds,
                ageSource: (
                  if $registry_entry == null then "unknown" else "worker-registry" end
                ),
                # The Worker records destroyed only after successful cleanup.
                # A live instance with this state is inconsistent.
                registryState: (
                  if $registry_entry == null then null else $registry_entry.row.state end
                ),
                registryCreatedAt: (
                  if $registry_entry == null then null else $registry_entry.row.createdAt end
                ),
                runnerName: authoritative_runner_name(
                  ($raw_registry_entry.row // null);
                  $uuid
                ),
                cloudflareCreated: $instance.created,
                inactiveInstance: null
              } as $record
            # `absent-from-registry` is sound only when the Cloudflare instance
            # snapshot completes before the Worker registry snapshot. Reversing
            # those reads can classify a sandbox spawned between them as an orphan.
            | if $record.ageSource == "unknown" then
                if $is_registered then
                  empty
                else
                  $record + {reason: "absent-from-registry"}
                end
              elif $record.ageSeconds < $grace then
                empty
              elif ($record.registryState | ascii_downcase) == "destroyed" then
                $record + {reason: "terminal-registry-row"}
              elif ($is_registered | not) then
                $record + {reason: "unregistered"}
              else
                empty
              end
          ),
          (
            $registry_entries[]
            # Ambiguous evidence must suppress every reverse-pass finding.
            | select(
                $ambiguous_by_sandbox[.row.sandboxId] == null
              )
            # A starting runner whose container is up has a live Cloudflare
            # instance, so the hasLiveInstance != true gate below excludes it.
            # The finding age gate uses Worker createdAt against audit_start
            # from the earlier Cloudflare snapshot. Later audit work cannot age
            # a fresh row into this finding. The default 60-second grace exceeds
            # the degraded 31-second spawn measured in MEASUREMENTS.md:744.
            | select(($audit_start - .createdEpoch) >= $grace)
            | . as $registry_entry
            | ($registry_entry.row.sandboxId | sandbox_uuid) as $uuid
            | (
                $instances_by_name[$registry_entry.row.sandboxId] // null
              ) as $matching_instances
            | select($matching_instances.hasLiveInstance != true)
            | ($matching_instances.inactiveInstance // null) as $inactive_instance
            | {
                sandboxId: $registry_entry.row.sandboxId,
                instanceId: null,
                uuid: $uuid,
                state: null,
                ageSeconds: $registry_entry.ageSeconds,
                ageSource: "worker-registry",
                registryState: $registry_entry.row.state,
                registryRevision: $registry_entry.row.revision,
                registryCreatedAt: $registry_entry.row.createdAt,
                runnerName: authoritative_runner_name(
                  $registry_entry.row;
                  $uuid
                ),
                cloudflareCreated: null,
                inactiveInstance: (
                  if $inactive_instance == null then
                    null
                  else
                    {
                      id: $inactive_instance.id,
                      state: $inactive_instance.state,
                      created: $inactive_instance.created
                    }
                  end
                )
              } as $record
            | if (
                $uuid != null and
                $registered_by_uuid[$uuid] != null
              ) then
                $record + {reason: "registered-without-instance"}
              else
                $record + {reason: "absent-from-cloudflare"}
              end
          )
        ]
        | sort_by(.sandboxId)
      end
  end;
