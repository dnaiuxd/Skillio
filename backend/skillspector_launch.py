"""Run SkillSpector with room to record everything it checks.

SkillSpector writes one "done" receipt per file per check and keeps at most
10,000 of them (MAX_INSPECTION_LEDGER_EVENTS, a Final with no setting). Work
whose receipt didn't fit is counted as partly read. strix-main needs 10,192,
so YARA — the last check to run — lost 313 receipts and the scan read as 38%
when it had read 93%: the same rules, run file by file, found the same 11 hits.

Skillio runs this file with SkillSpector's own interpreter instead of the
`skillspector` script. It raises the ceiling before anything else in
SkillSpector is imported (state.py and cli.py copy the value by name at
import), then hands over to SkillSpector's own entry point unchanged. Nothing
in the installed package is edited, so a reinstall or upgrade keeps it.

If a SkillSpector release renames or drops the constant, this runs the scan
exactly as the plain command would. The incomplete-scan notice still says
when the ceiling was hit.
"""
import sys

# Measured on strix-main: no change in scan time or report size (+1.5 KB of
# 816 KB). Room for roughly 3,700 files at the ~27 checks each one gets.
LEDGER_EVENTS = 100_000


def raise_ledger_ceiling() -> bool:
    """True when the ceiling was raised; False leaves SkillSpector as it is."""
    try:
        import skillspector.inspection_ledger as ledger
    except Exception:
        return False
    current = getattr(ledger, "MAX_INSPECTION_LEDGER_EVENTS", None)
    if not isinstance(current, int) or isinstance(current, bool):
        return False
    ledger.MAX_INSPECTION_LEDGER_EVENTS = max(current, LEDGER_EVENTS)
    return True


def main(argv: list[str]) -> object:
    raise_ledger_ceiling()
    from skillspector.cli import app

    sys.argv = ["skillspector", *argv]
    return app()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
