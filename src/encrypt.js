/* @flow */

// TODO: lifted wholesale from the Browser.
// will remove once it's merged to blockstack.js

import bip39 from 'bip39'
import crypto from 'crypto'
import triplesec from 'triplesec'

function normalizeMnemonic(mnemonic: string) {
  return bip39.mnemonicToEntropy(mnemonic).toString('hex')
} 

function denormalizeMnemonic(normalizedMnemonic : string) {
  return bip39.entropyToMnemonic(normalizedMnemonic)
} 

function encryptMnemonic(plaintextBuffer : Buffer, password: string) : Promise<Buffer> {
  return Promise.resolve().then(() => {
    // must be bip39 mnemonic 
    if (!bip39.validateMnemonic(plaintextBuffer.toString())) {
      throw new Error('Not a valid bip39 nmemonic')
    }

    // normalize plaintext to fixed length byte string
    const plaintextNormalized = Buffer.from(
      normalizeMnemonic(plaintextBuffer.toString()), 'hex')

    // AES-128-CBC with SHA256 HMAC 
    const salt = crypto.randomBytes(16)
    const keysAndIV = crypto.pbkdf2Sync(password, salt, 100000, 48, 'sha512')
    const encKey = keysAndIV.slice(0, 16)
    const macKey = keysAndIV.slice(16, 32)
    const iv = keysAndIV.slice(32, 48)

    const cipher = crypto.createCipheriv('aes-128-cbc', encKey, iv)
    let cipherText = cipher.update(plaintextNormalized, undefined, 'hex')
    cipherText += cipher.final('hex')

    const hmacPayload = Buffer.concat([salt, Buffer.from(cipherText, 'hex')])

    const hmac = crypto.createHmac('sha256', macKey)
    hmac.write(hmacPayload)
    const hmacDigest = hmac.digest()

    const payload = Buffer.concat([salt, hmacDigest, Buffer.from(cipherText, 'hex')])
    return payload
  })
}

function decryptMnemonic(dataBuffer: Buffer, password: string) : Promise<string> {
  return Promise.resolve().then(() => {
    const salt = dataBuffer.slice(0, 16)
    const hmacSig = dataBuffer.slice(16, 48)   // 32 bytes
    const cipherText = dataBuffer.slice(48)
    const hmacPayload = Buffer.concat([salt, cipherText])

    const keysAndIV = crypto.pbkdf2Sync(password, salt, 100000, 48, 'sha512')
    const encKey = keysAndIV.slice(0, 16)
    const macKey = keysAndIV.slice(16, 32)
    const iv = keysAndIV.slice(32, 48)

    const decipher = crypto.createDecipheriv('aes-128-cbc', encKey, iv)
    let plaintext = decipher.update(cipherText.toString('hex'), 'hex').toString('hex')
    plaintext += decipher.final().toString('hex')

    const hmac = crypto.createHmac('sha256', macKey)
    hmac.write(hmacPayload)
    const hmacDigest = hmac.digest()

    // hash both hmacSig and hmacDigest so string comparison time
    // is uncorrelated to the ciphertext 
    const hmacSigHash = crypto.createHash('sha256')
      .update(hmacSig)
      .digest()
      .toString('hex')

    const hmacDigestHash = crypto.createHash('sha256')
      .update(hmacDigest)
      .digest()
      .toString('hex')
    
    if (hmacSigHash !== hmacDigestHash) {
      // not authentic
      throw new Error('Wrong password (HMAC mismatch)')
    }

    const mnemonic = denormalizeMnemonic(plaintext)
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Wrong password (invalid plaintext)')
    }

    return mnemonic
  })
}


export function encryptBackupPhrase(plaintextBuffer: Buffer, password: string) : Promise<Buffer> {
  return encryptMnemonic(plaintextBuffer, password)
}

export function decryptBackupPhrase(dataBuffer: Buffer, password: string) : Promise<string> {
  return decryptMnemonic(dataBuffer, password)
  .catch((e) => // try the old way
    new Promise((resolve, reject) => {
      triplesec.decrypt(
        {
          key: new Buffer(password),
          data: dataBuffer
        },
        (err, plaintextBuffer) => {
          if (!err) {
            resolve(plaintextBuffer)
          } else {
            reject(new Error(`current algorithm: "${e.message}", ` +
              `legacy algorithm: "${err.message}"`))
          }
        }
      )
    })
  )
}

