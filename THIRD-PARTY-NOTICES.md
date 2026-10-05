# Third-party notices

Editdock is licensed under the MIT License. See `LICENSE`.

## Packed SDK payload

The packed SDK has no npm runtime dependencies. Inspection of the source import graph and built JavaScript/declaration output found only Editdock modules and, in the Node renderer, Node.js built-in modules; no separately licensed third-party source or runtime helper was identified in the packed payload.

The packages recorded as development dependencies in `package-lock.json` are build and test tools. They are not made runtime dependencies or redistributed merely because they appear in the lockfile, and the npm package file allowlist does not include `node_modules`.

If third-party source or a build runtime helper is later included in the packed payload, retain its applicable attribution and license terms here and in the distributed archive.

## Host-supplied and user-supplied materials

The MIT License for Editdock does not bundle, license, or relicense FFmpeg, ffprobe, codec builds, media, fonts, LUTs, or models supplied by a host or user. The packed SDK contains none of those materials. A host or distributor must review the licenses, notices, patent obligations, and redistribution terms for the exact materials and executable builds it supplies.
