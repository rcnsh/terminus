# The Mac keeps its device token in a private file, not the keychain

The Mac app is signed with a self-signed certificate and has no Apple Team ID, so the keychain knows each version only by its code hash and asked for the token after every update (3aefdebb). The token is kept in `~/Library/Application Support/terminus/device-token` instead (mode 0600, in a 0700 folder, swapped in atomically) (b94b67f6). Moving it back into the keychain needs a Developer ID first.
