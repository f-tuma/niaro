# niar-263-thread-continuity

Consecutive turns of a chat continue one assistant thread: a memory change elsewhere in the workspace, the pet learner noticing something, a save, a policy change of a chat that used no service result, or a retry no longer start the model afresh. A thread still starts afresh when memory it actually used was forgotten, corrected, expired or became inaccessible (NIAR-263).
