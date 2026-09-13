# Fork releases

Every push to `main` builds the mobile dependency closure and publishes 13 package archives with a `manifest.json` and MIT license. Release tags use `fork-<full source commit>`; consumers must pin a specific release. The manifest contains each archive's SHA-256 and the source commit. A manual workflow run can use a `fork-vMAJOR.MINOR.PATCH` tag. Existing release tags must not be reused.

Download URLs have the form:

```
https://github.com/coldiary/special-translation/releases/download/<tag>/<filename>
```

Install `gt`, `gt-react`, and `gt-react-native` using the corresponding archive URLs. Override the remaining ten package names with their archive URLs so the entire GT dependency graph uses the same fork snapshot. Keep the resulting lockfile committed. Import names remain compatible with upstream; package names and versions inside archives identify the upstream API version, while the pinned URL identifies this independent fork.

Public release downloads need no GitHub token. Publishing uses the workflow's short-lived `GITHUB_TOKEN`; no personal token is required. The original upstream npm release workflow is restricted to `generaltranslation/gt`.

Preserve license and third-party notices when redistributing packages. The archives include these notices.
