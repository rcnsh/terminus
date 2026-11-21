import CryptoKit
import Foundation

let args = CommandLine.arguments
guard args.count == 4 else {
    FileHandle.standardError.write(Data("usage: swift scripts/release/verify-sparkle.swift <public key> <signature> <file>\n".utf8))
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
