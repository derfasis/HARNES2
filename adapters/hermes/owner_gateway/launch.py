"""Start Hermes' own messaging gateway as the owner's chat with the partner.

Hermes does the talking, keeps the sessions and the long-term memory, and loads its .env and
config.yaml from its home (data/hermes-gateway, prepared by setup.py). This file only points
Hermes at that home, tells it where its installer keeps optional packages, names the project for
the partner-desk plugin, and leaves out the host/terminal environment block the model route
rejects (adapters/hermes/prompt_scope.py), exactly as the partner's desk runs do.

Without arguments it runs the gateway. With arguments it runs that Hermes command in the same home
and scope, e.g. `launch.py memory status` or a one-shot `launch.py -z "..."` for a check.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HOME = ROOT / "data" / "hermes-gateway"


def main() -> None:
    if not (HOME / "config.yaml").is_file():
        sys.exit("The owner chat is not set up yet. Run: npm run chat:setup")
    os.environ["HERMES_HOME"] = str(HOME)
    os.environ["HERMES_LAZY_INSTALL_TARGET"] = str(HOME / "packages")
    os.environ["HARNES2_ROOT"] = str(ROOT)
    os.chdir(HOME)
    sys.path.insert(0, str(ROOT / "runtime" / "hermes-agent"))
    sys.path.insert(0, str(ROOT / "adapters" / "hermes"))
    from prompt_scope import omit_host_environment

    omit_host_environment()
    sys.argv = ["hermes", *(sys.argv[1:] or ["gateway", "run"])]
    from hermes_cli.main import main as hermes

    hermes()


if __name__ == "__main__":
    main()
