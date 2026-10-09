#!/system/bin/sh
# Runs one transcription on the device and reports wall time and peak RSS.
# Usage: device-run.sh <model> <wav> <out-prefix> <threads> [extra whisper args...]
cd "$(dirname "$0")" || exit 2
model="$1"; wav="$2"; out="$3"; threads="$4"; shift 4
start=$(date +%s%N)
rm -f "$out.code" "$out.json"
# mksh may reap a finished job before `wait`, so the subshell records the status.
(./whisper-cli -m "$model" -f "$wav" -t "$threads" -l en -oj -of "$out" "$@" > "$out.log" 2>&1; echo $? > "$out.code") &
pid=$!
peak=0
child=""
while kill -0 "$pid" 2>/dev/null; do
  # Sample the whisper-cli child, not the wrapper subshell.
  [ -z "$child" ] && child=$(pgrep -P "$pid" whisper-cli 2>/dev/null | head -n 1)
  if [ -n "$child" ]; then
    value=$(sed -n 's/^VmHWM:[^0-9]*\([0-9]*\).*/\1/p' "/proc/$child/status" 2>/dev/null)
    [ -n "$value" ] && peak=$value
  fi
  sleep 0.05
done
wait "$pid" 2>/dev/null
code=$(cat "$out.code" 2>/dev/null || echo 255)
end=$(date +%s%N)
# mksh arithmetic is 32-bit; the host subtracts the nanosecond timestamps.
echo "RESULT code=$code start=$start end=$end peakRssKb=$peak"
