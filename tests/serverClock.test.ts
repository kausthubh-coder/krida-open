import { expect, test } from "vitest";
import { createServerClock } from "../src/features/party/serverClock";

/** A device clock moved by hand, and servers that answer behind it by a set amount, counting the asks. */
function setup() {
  let t = Date.UTC(2026, 9, 20, 21, 0);
  const asks = { count: 0 };
  const server = (behind: number) => async () => {
    asks.count++;
    return t - behind;
  };
  const down = async (): Promise<number> => {
    asks.count++;
    throw new Error("offline");
  };
  const clock = createServerClock(() => t);
  return { clock, server, down, asks, device: () => t, wait: (ms: number) => (t += ms) };
}

test("measured, the server's time is this device's less the difference", async () => {
  const { clock, server, device } = setup();
  await clock.measure(server(20_000));
  expect(clock.now()).toBe(device() - 20_000);
});

test("when no answer comes back, the device's clock stands in and the next screen to ask measures again", async () => {
  const { clock, server, down, device } = setup();
  await clock.measure(down);
  expect(clock.now()).toBe(device());
  await clock.measure(server(20_000));
  expect(clock.now()).toBe(device() - 20_000);
});

test("back on screen after a minute, it measures again: a laptop that slept has drifted", async () => {
  const { clock, server, device, wait } = setup();
  await clock.measure(server(20_000));
  wait(61_000);
  await clock.measure(server(25_000), true);
  expect(clock.now()).toBe(device() - 25_000);
});

test("back on screen within a minute, it keeps what it measured", async () => {
  const { clock, server, device, wait, asks } = setup();
  await clock.measure(server(20_000));
  wait(30_000);
  await clock.measure(server(25_000), true);
  expect(clock.now()).toBe(device() - 20_000);
  expect(asks.count).toBe(3);
});

test("a measurement that fails later keeps the last good one", async () => {
  const { clock, server, down, device, wait } = setup();
  await clock.measure(server(20_000));
  wait(61_000);
  await clock.measure(down, true);
  expect(clock.now()).toBe(device() - 20_000);
});

test("screens asking at once share one measurement", async () => {
  const { clock, server, asks } = setup();
  await Promise.all([clock.measure(server(20_000)), clock.measure(server(20_000)), clock.measure(server(20_000), true)]);
  expect(asks.count).toBe(3);
});
