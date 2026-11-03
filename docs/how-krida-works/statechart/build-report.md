# KridaBuild

TLC reached 55 states and 133 steps. The chart draws 11 states and 22 arrows.
The chart does not draw 51 steps that stay in one chart state.
The view hides 10 steps, so the chart does not draw them.

## OneBuildAtATime breaks
The shortest path has 5 steps:
0. Nothing started
1. you rest on Play: Resting on Play
2. the warm-up starts: The warm-up holds the claim
3. 3 minutes pass: The warm-up's claim is past 3 minutes
4. you press Play: Play pressed
5. Play takes over the expired claim: Two builds of one title

## Rules that hold
NoDeadlock, PlayNeverWaitsForever
