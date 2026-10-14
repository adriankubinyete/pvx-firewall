import { expect, test } from "bun:test";
import { collect, filterCandidates, parsePeers } from "../src/asterisk.ts";
import { fakeExec, shellOf } from "./fake.ts";

const SIP = `Name/username             Host                                    Dyn Forcerport Comedia    ACL Port     Status      Description
1000/1000                 189.10.20.30                            D  Yes        Yes            5060     OK (12 ms)
1001/1001                 192.168.0.50                            D  Yes        Yes            5060     OK (3 ms)
trunk-vivo/trunk-vivo     200.100.50.25                              No         No             5060     OK (20 ms)
1002/1002                 (Unspecified)                           D  Yes        Yes            0        UNKNOWN
4 sip peers [Monitored: 2 online, 1 offline Unmonitored: 0 online, 1 offline]`;

const PJSIP = ` Contact:  2000/sip:2000@177.1.2.3:5060;ob          abc123 Avail        12.345
 Contact:  2001/sip:2001@10.1.1.9:5060                 def456 Avail        3.1
 Transport:  transport-udp             udp      0      0  0.0.0.0:5060
Endpoint:  2000                                                 Not in use    0 of inf`;

test("parses peers and hosts from sip show peers", () => {
  expect(parsePeers(SIP)).toEqual([
    { ip: "189.10.20.30", peer: "1000" },
    { ip: "192.168.0.50", peer: "1001" },
    { ip: "200.100.50.25", peer: "trunk-vivo" },
  ]);
});

test("parses pjsip contacts and ignores transports", () => {
  expect(parsePeers(PJSIP)).toEqual([
    { ip: "177.1.2.3", peer: "2000" },
    { ip: "10.1.1.9", peer: "2001" },
  ]);
});

test("filters private, loopback, own host and already-trusted IPs; names every peer on an IP", () => {
  const peers = [...parsePeers(SIP), ...parsePeers(PJSIP), { ip: "127.0.0.1", peer: "lo" }, { ip: "0.0.0.0", peer: "x" }, { ip: "203.0.113.50", peer: "own" }, { ip: "186.233.122.92", peer: "abner" }, { ip: "189.10.20.30", peer: "1003" }];
  const r = filterCandidates(peers, ["203.0.113.50"], ["186.233.0.0/16"]);
  expect(r.candidates).toEqual([
    { ip: "189.10.20.30", peer: "1000, 1003" },
    { ip: "200.100.50.25", peer: "trunk-vivo" },
    { ip: "177.1.2.3", peer: "2000" },
  ]);
  expect(Object.fromEntries(r.skipped.map((s) => [s.ip, s.why]))).toEqual({
    "192.168.0.50": "privado ou loopback",
    "10.1.1.9": "privado ou loopback",
    "127.0.0.1": "privado ou loopback",
    "0.0.0.0": "privado ou loopback",
    "203.0.113.50": "IP do próprio host",
    "186.233.122.92": "já confiável",
  });
});

test("collect asks asterisk -rx for sip and pjsip; a missing asterisk is reported, not an error", async () => {
  const { exec, calls } = fakeExec((c) => (c.args[1] === "sip show peers" ? { stdout: SIP } : undefined));
  const r = await collect(shellOf(exec));
  expect(calls.map((c) => c.args.join(" "))).toEqual(["-rx sip show peers", "-rx pjsip show contacts", "-rx pjsip show endpoints"]);
  expect(r.asterisk).toBe(true);
  expect(r.peers).toHaveLength(3);
  const none = await collect(shellOf(fakeExec(() => ({ code: 127 })).exec));
  expect(none).toEqual({ peers: [], asterisk: false });
});
