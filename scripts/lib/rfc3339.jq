def rfc3339_error($value):
  error("invalid RFC 3339 timestamp: \($value | tojson)");

def rfc3339_to_epoch:
  . as $value
  | if type != "string" then
      rfc3339_error($value)
    else
      [
        capture(
          "^(?<date>[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]))[Tt](?<time>(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9])(?:\\.(?<fraction>[0-9]+))?(?<timezone>[Zz]|(?<offset_sign>[+-])(?<offset_hour>(?:[01][0-9]|2[0-3])):(?<offset_minute>[0-5][0-9]))\\z"
        )
      ] as $matches
      | if ($matches | length) != 1 then
          rfc3339_error($value)
        else
          $matches[0] as $parts
          | ($parts.date + "T" + $parts.time + "Z") as $canonical
          | (
              try ($canonical | fromdateiso8601)
              catch rfc3339_error($value)
            ) as $base_epoch
          | if ($base_epoch | strftime("%Y-%m-%dT%H:%M:%SZ")) != $canonical then
              rfc3339_error($value)
            else
              (
                if ($parts.timezone | ascii_downcase) == "z" then
                  0
                else
                  (
                    (($parts.offset_hour | tonumber) * 3600) +
                    (($parts.offset_minute | tonumber) * 60)
                  ) * if $parts.offset_sign == "+" then 1 else -1 end
                end
              ) as $offset_seconds
              | $base_epoch - $offset_seconds
            end
        end
    end;
