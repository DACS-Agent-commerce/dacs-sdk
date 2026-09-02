import { isIP } from "node:net";

const ipv4Number = (address: string): number | null => {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number)
    .reduce((value, part) => value * 256 + part, 0) >>> 0;
};

const ipv4InCidr = (value: number, base: string, prefix: number): boolean => {
  const baseValue = ipv4Number(base);
  if (baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
};

function ipv6Number(address: string): bigint | null {
  if (address.includes("%")) return null;
  let value = address.toLowerCase();
  const ipv4Tail = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const encoded = ipv4Number(ipv4Tail);
    if (encoded === null) return null;
    value = `${value.slice(0, -ipv4Tail.length)}${(encoded >>> 16).toString(16)}:${(
      encoded & 0xffff
    ).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(parseInt(group, 16)),
    0n,
  );
}

const ipv6InCidr = (value: bigint, base: string, prefix: number): boolean => {
  const baseValue = ipv6Number(base);
  if (baseValue === null) return false;
  const shift = BigInt(128 - prefix);
  return value >> shift === baseValue >> shift;
};

// Snapshot: IANA IPv6 Global Unicast Address Assignments, 2025-10-10.
// Include every ALLOCATED prefix except protocol/special-purpose ranges that
// DACS deliberately refuses. Omitted 2000::/3 space fails closed; omission is
// not itself a claim that every address in that space is IANA-reserved.
const IPV6_ALLOCATED_GLOBAL_UNICAST_V1: readonly (readonly [string, number])[] = [
  ["2001:200::", 23], ["2001:400::", 23], ["2001:600::", 23],
  ["2001:800::", 22], ["2001:c00::", 23], ["2001:e00::", 23],
  ["2001:1200::", 23], ["2001:1400::", 22], ["2001:1800::", 23],
  ["2001:1a00::", 23], ["2001:1c00::", 22], ["2001:2000::", 19],
  ["2001:4000::", 23], ["2001:4200::", 23], ["2001:4400::", 23],
  ["2001:4600::", 23], ["2001:4800::", 23], ["2001:4a00::", 23],
  ["2001:4c00::", 23], ["2001:5000::", 20], ["2001:8000::", 19],
  ["2001:a000::", 20], ["2001:b000::", 20], ["2003::", 18],
  ["2400::", 12], ["2410::", 12], ["2600::", 12],
  ["2610::", 23], ["2620::", 23], ["2630::", 12],
  ["2800::", 12], ["2a00::", 12], ["2a10::", 12],
  ["2c00::", 12],
];

const IPV6_REFUSED_SPECIAL_PURPOSE_V1: readonly (readonly [string, number])[] = [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96],
  ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48],
  ["3fff::", 20], ["fc00::", 7], ["fe80::", 10],
  ["fec0::", 10], ["ff00::", 8],
];

/** Conservative DACS-1 public-target classifier for IPv4 and IPv6 literals. */
export function isDacsPublicAddressV1(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address)!;
    return ![
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
      ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
      ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24],
      ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
      ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([base, prefix]) => ipv4InCidr(value, base as string, prefix as number));
  }
  if (family === 6) {
    const value = ipv6Number(address);
    if (value === null) return false;
    return IPV6_ALLOCATED_GLOBAL_UNICAST_V1.some(
      ([base, prefix]) => ipv6InCidr(value, base, prefix),
    ) && !IPV6_REFUSED_SPECIAL_PURPOSE_V1.some(
      ([base, prefix]) => ipv6InCidr(value, base, prefix),
    );
  }
  return false;
}
