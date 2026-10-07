// How the server process itself is doing: CPU time, memory, how busy its
// event loop is and how late it runs. The load test (tests/load) asks for it
// over the IPC channel of the process that started the server (index.ts →
// the "stats" message): nothing on the network can ask.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export interface ProcessStats {
	/** when it was taken (ms since 1970) */
	at: number;
	/** CPU time used since the process started (µs) */
	cpu: { user: number; system: number };
	/** bytes */
	memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
	/**
	 * The event loop's busy and idle time since the process started (ms). How
	 * busy it was over a period is the difference of two: active / (active + idle).
	 * Near 1, everything waits for everything else (one core is all a Node
	 * process runs JavaScript on).
	 */
	loop: { active: number; idle: number };
	/**
	 * How late the event loop got to a timer since the previous stats (ms):
	 * what every event waits on top of its own work. `tick`: how often this
	 * system's timers can fire at best, which is what "late" is measured from
	 * (Windows: about every 15.6 ms; there the figures are only that exact).
	 */
	loopDelay: { p50: number; p99: number; max: number; tick: number };
	/** live connections (signed in) */
	sockets: number;
}

const RESOLUTION_MS = 10;
// (the histogram's type by what returns it: @types/node does not export its
// name from "node:perf_hooks" in every version)
let delay: ReturnType<typeof monitorEventLoopDelay> | null = null;
/**
 * How often the timer really fires when nothing is late (ns): the shortest
 * time between two ticks seen so far, but not under the 10 ms asked for (one
 * tick may come a little early after a late one). That is 10 ms where the
 * system's timers allow it (Linux, macOS), and ~15.6 ms on Windows, whose
 * timers tick at that rate: counted from 10 ms, an idle server there would
 * seem 6 ms late all the time.
 */
let tick = Infinity;

/** The figures now; `sockets` from the caller (the socket layer knows). */
export function processStats(sockets: number): ProcessStats {
	// (measured from the first request on: nothing runs for a server nobody asks)
	if (!delay) {
		delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
		delay.enable();
	}
	// the histogram holds the time between ticks: less the tick itself, that is how late it was
	if (delay.count > 0) tick = Math.min(tick, Math.max(delay.min, RESOLUTION_MS * 1e6));
	const ms = (ns: number) => Math.round((ns / 1e6) * 100) / 100;
	const late = (ns: number) => Math.max(0, ms(ns - tick));
	const elu = performance.eventLoopUtilization();
	const m = process.memoryUsage();
	const stats: ProcessStats = {
		at: Date.now(),
		cpu: process.cpuUsage(),
		memory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external },
		loop: { active: elu.active, idle: elu.idle },
		loopDelay:
			delay.count > 0
				? { p50: late(delay.percentile(50)), p99: late(delay.percentile(99)), max: late(delay.max), tick: ms(tick) }
				: { p50: 0, p99: 0, max: 0, tick: RESOLUTION_MS },
		sockets,
	};
	delay.reset();
	return stats;
}
