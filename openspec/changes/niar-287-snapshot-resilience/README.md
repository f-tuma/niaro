# niar-287-snapshot-resilience

A process started from a meeting no longer takes the person's app offline when it finishes: the server can now describe the output of a meeting run, and a single task it cannot show is skipped and logged instead of failing every snapshot, events, chat and voice request for that person (NIAR-287).
