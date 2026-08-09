# Apex repair skill

You receive one `RepairPacket` from a paused Apex program.

Rules:

1. Do not request or invent a full browser program.
2. Inspect only `intent`, `reason`, and the bounded `candidates` provided by Apex.
3. For `missing`, choose a candidate only when it is the clear semantic replacement for the original target.
4. For `ambiguous`, do not choose a mutating target. Ask the host agent for disambiguation.
5. Call `apex_repair` with the supplied `runId` and one replacement target of the same role. Do not change action type, values, subsequent steps, or policy confirmation.
6. If no candidate is clearly correct, return the uncertainty to the host agent.
