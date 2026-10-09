// Process and device sampling for Audio Journal load runs (PSS, heaps, CPU,
// thermal). Shared by the load and speech harnesses.
import * as d from './device.mjs';

export function pid() {
  return d.shell('pidof', d.PACKAGE).trim().split(/\s+/)[0];
}

export function memory() {
  const text = d.shell('dumpsys', 'meminfo', d.PACKAGE);
  const row = name => {
    const match = new RegExp(`^\\s*${name}\\s+(\\d+)`, 'm').exec(text);
    return match ? Number(match[1]) : undefined;
  };
  return {
    totalPssKb: Number(
      /TOTAL PSS:\s+(\d+)/.exec(text)?.[1] ?? /TOTAL\s+(\d+)/.exec(text)?.[1],
    ),
    totalRssKb: Number(/TOTAL RSS:\s+(\d+)/.exec(text)?.[1] ?? NaN),
    javaHeapKb: row('Java Heap:'),
    nativeHeapKb: row('Native Heap:'),
    graphicsKb: row('Graphics:'),
  };
}

function cpuTicks(processId) {
  const fields = d
    .shell('cat', `/proc/${processId}/stat`)
    .split(') ')[1]
    .split(' ');
  return Number(fields[11]) + Number(fields[12]); // utime + stime
}

function thermal() {
  const text = d.shell('dumpsys', 'thermalservice');
  return Number(/Thermal Status: (\d+)/.exec(text)?.[1] ?? NaN);
}

function battery() {
  const text = d.shell('dumpsys', 'battery');
  return {
    level: Number(/level: (\d+)/.exec(text)?.[1]),
    temperatureC: Number(/temperature: (\d+)/.exec(text)?.[1]) / 10,
  };
}

export function startSampler(label, intervalMs = 3_000) {
  const samples = [];
  const processId = pid();
  let lastTicks = cpuTicks(processId);
  let lastAt = Date.now();
  const hz = 100;
  const cores = Number(d.shell('nproc').trim()) || 1;
  const timer = setInterval(() => {
    try {
      const ticks = cpuTicks(processId);
      const at = Date.now();
      const cpuPercent =
        ((ticks - lastTicks) / hz / ((at - lastAt) / 1000)) * 100;
      lastTicks = ticks;
      lastAt = at;
      samples.push({
        t: at,
        cpuPercent: Math.round(cpuPercent),
        cores,
        ...memory(),
        thermal: thermal(),
      });
    } catch {
      // the process can be between states; skip this sample
    }
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return { label, samples, ...summarizeSamples(samples) };
    },
  };
}

export function summarizeSamples(samples) {
  const pick = key =>
    samples.map(sample => sample[key]).filter(Number.isFinite);
  const stats = values =>
    values.length
      ? {
          min: Math.min(...values),
          max: Math.max(...values),
          mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
          first: values[0],
          last: values[values.length - 1],
        }
      : undefined;
  return {
    count: samples.length,
    pssKb: stats(pick('totalPssKb')),
    nativeHeapKb: stats(pick('nativeHeapKb')),
    javaHeapKb: stats(pick('javaHeapKb')),
    cpuPercent: stats(pick('cpuPercent')),
    thermalMax: Math.max(...pick('thermal'), 0),
  };
}
