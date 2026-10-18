# Example flow (illustrative, not a real ChatGPT response)

1. The user runs `nova-agent fix "Login returns 401 for a valid user"`.
2. The provider responds with `NEED_FILES` and requests `src/auth/routes.ts` and `src/auth/service.ts`.
3. Nova Agent checks each path against `.novaignore`, `.gitignore`, sensitive-path rules, and the project boundary. It computes SHA-256 and sends only those file contents.
4. If the hashing algorithm or session policy remains unknown, the provider responds with `NEED_INFO` and one question.
5. Nova Agent displays the question in the terminal and persists the user's answer.
6. The provider can then return `PATCH_READY` with a unified patch. Nova Agent validates it, previews it, and waits for a separate user confirmation.
7. If the user approves, Nova Agent backs up touched files, applies the patch, executes only preconfigured tests, commits touched paths to the auxiliary Git repository, and updates the Markdown report.
8. If the user rejects the proposal, no source files are changed and no correction commit is created.
