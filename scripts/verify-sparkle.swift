// Checks a Sparkle EdDSA signature the way an installed app does: Ed25519
// over the whole file, with the app's SUPublicEDKey. scripts/release.sh and
// scripts/release-beta.sh run it after sign_update, so a Sparkle key that
// isn't the app's stops the release instead of every Mac's update.
//
//   swift scripts/verify-sparkle.swift <public key, base64> <signature, base64> <file>
import CryptoKit
import Foundation

let args = CommandLine.arguments
guard args.count == 4 else {
  FileHandle.standardError.write(Data("usage: swift scripts/verify-sparkle.swift <public key> <signature> <file>\n".utf8))
  exit(2)
}
guard let raw = Data(base64Encoded: args[1]), let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw) else {
  FileHandle.standardError.write(Data("the public key isn't a base64 Ed25519 key\n".utf8))
  exit(2)
}
guard let signature = Data(base64Encoded: args[2]) else {
  FileHandle.standardError.write(Data("the signature isn't base64\n".utf8))
  exit(2)
}
guard let file = try? Data(contentsOf: URL(fileURLWithPath: args[3]), options: .alwaysMapped) else {
  FileHandle.standardError.write(Data("can't read \(args[3])\n".utf8))
  exit(2)
}
if key.isValidSignature(signature, for: file) {
  print("Sparkle signature matches SUPublicEDKey")
} else {
  FileHandle.standardError.write(Data("the Sparkle signature doesn't match the public key\n".utf8))
  exit(1)
}
