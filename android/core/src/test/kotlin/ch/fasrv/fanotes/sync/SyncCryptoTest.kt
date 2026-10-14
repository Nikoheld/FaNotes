package ch.fasrv.fanotes.sync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SyncCryptoTest {
    @Test
    fun matchesWebCryptoPbkdfHkdfAndGcm() {
        val kdf = SyncKdf(KDF_ALGORITHM, 600_000, "BwcHBwcHBwcHBwcHBwcHBw==")
        val derived = deriveFromPassword("correct horse", kdf)
        assertEquals("saxYt/CRDF/iHXI2qfjJpUg3bzKF7dq3ShKAatTvTrM=", toBase64(derived.wrappingKey.encoded))
        assertEquals("fj/4BdPX4pXb7EVF4Qai4jGIIa56Whfc3HWffRXWoVg=", derived.authKey)

        val secret = ByteArray(32) { 9 }
        val keys = deriveSyncKeys(secret)
        assertEquals("61509d959b50bb0219de4f88a3b4f0e024e1ec539b52c3639d1b99847fe535a6", toHex(keys.data.encoded))
        assertEquals("e8006b08f6c45fef29875c54ab91ea3c536d9ff93a5445808432da63b80da2c7", toHex(keys.id.encoded))
        assertEquals("245975775ddbab24f3cae75a233d07553bbde2ebfe1240e7b5d01449d9560bca", fileIdFor(keys, "Notes/Hello.md"))

        val blob = encryptBytes(keys, "ab".repeat(32), "Hello FaNotes".toByteArray(), ByteArray(12) { 3 })
        assertEquals("AwMDAwMDAwMDAwMDa/u/TOb07+9QYg68DCSB96NbrivviPmQKONRz4I=", toBase64(blob))
        assertEquals("Hello FaNotes", decryptBytes(keys, "ab".repeat(32), blob).decodeToString())
    }

    @Test
    fun rejectsShortPasswords() {
        assertTrue(passwordProblems("short") != null)
        assertEquals(null, passwordProblems("a real passphrase"))
    }
}
