# Contributing

Bugs in this repository belong in a companion-defect issue. Station API or persona behavior that this process only calls belongs in a Subwave-defect issue. Wrong environment, ports, or credentials belong in an operator-configuration issue.

1. Branch from `main`.
2. Keep the change inside the module `AGENTS.md` names for that area.
3. If behavior changes, update the contract test and the operator docs in the same change.
4. Run `npm test`.

Do not commit secrets, `.env`, `config.yaml`, `logs/`, workspace state under `data/`, or a private station prompt over `prompt.md`.
