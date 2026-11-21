#!/bin/sh
# usage: sample.sh out seconds
end=$(( $(date +%s) + $2 ))
while [ $(date +%s) -lt $end ]; do
  ids=$( (docker ps -q --filter name=lpc-54e9c3; docker ps -q --filter network=lpc-54e9c3_apps | sort -u) | sort -u)
  [ -n "$ids" ] || break
  docker stats --no-stream --format '{"t":"'"$(date +%T)"'","name":"{{.Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","pids":"{{.PIDs}}"}' $ids >> "$1"
done
