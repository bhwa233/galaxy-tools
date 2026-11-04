// Offline UPXS format parameters, checked against the official uTools 8.0.2
// Linux addon SHA-256 b8f96f70e87d2f5c07f1fae9182d6d1472b66403d4ede8a73cd3bfdf1ae96086.
// The addon is never executed or shipped. These static format parameters are
// not author signatures. See Docs/utools-package-format.md for provenance.
export const upxsProfile = {
  header: {
    key: "3e37464671234c4b3f4c7c4a302e6428704647797e6537243b775d5d75544f58",
    nonce: "41364647606539335d2f7d34324b6175585b4f4951724e3a",
  },
  check: {
    key: "737a717e3469487a413f78363e2c6447754b6521507e682e7460767b7b614e37",
    nonce: "6f527d4f50664e58232b6a2622216b3d5759434f7d7c3176",
  },
} as const;
