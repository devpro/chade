# Report

1. Measure what takes disk and memory, without changing anything:

   <!-- verify: timeout=120 expect="Memory" -->

   ```bash exec
   chade report
   ```

   > [!NOTE]
   > Each finding comes with the command or the setting that fixes it, and a link to its step in `docs/cleanup.md`.
   > On WSL, the report also measures the free space of `C:`, the virtual disk of each distribution and the memory settings of `.wslconfig`.

2. [The **Report** page](:action:ui.report) shows the same, a card for each section, a bar for each size.

3. Show what the clean-up would run, the steps listed under `cleanup` in the configuration:

   <!-- verify: expect="npm-cache" -->

   ```bash exec
   chade clean --dry-run
   ```

   > [!TIP]
   > `chade clean` asks for a confirmation, and `--yes` runs it from a timer or a script.
