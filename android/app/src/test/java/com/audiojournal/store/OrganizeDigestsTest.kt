package com.audiojournal.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The native journal.organize@1 digests against known answers computed
 * independently (Python hashlib and hmac) over the same UTF-8 bytes.
 */
class OrganizeDigestsTest {
  private val testKey = "1bade0643fc491eed82cc19363e815c1d378894aab5c8fc1ae3857fd6cce1cfa"
  private val unicode = "Caf\u00e9 \uD83D\uDE00 with Zo\u00eb \u2014 \u6771\u4eac"

  @Test
  fun sha256OfUtf8Text() {
    assertEquals(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        OrganizeDigests.sha256Hex(""))
    assertEquals(
        "0e2cfe575f799fbf29123d6241fb9ebdf78fe30f7264f8b6926ee2738624172d",
        OrganizeDigests.sha256Hex("Call Mom tonight."))
    assertEquals(
        "f35874b7563cea0ef6739e2b924fcf1ad3386965f173df1d43c0aeac41dc8380",
        OrganizeDigests.sha256Hex(unicode))
  }

  @Test
  fun hmacOverLabelZeroAndText() {
    assertEquals(
        "9c66d9dbb5455cfeb223a1e2840b3c701ddb2075a7090631d273b0037ac3ef3c",
        OrganizeDigests.hmacSha256Hex(testKey, "journal.organize@1", "Call Mom tonight."))
    assertEquals(
        "febe9f59aff979e0bc6861b1b4358de78bd0d26f8dd96bb7f841d2cbd17d116c",
        OrganizeDigests.hmacSha256Hex(testKey, "journal.organize@1", unicode))
  }

  @Test
  fun refusesAKeyThatIsNot32BytesOfLowerCaseHex() {
    for (bad in listOf("", testKey.dropLast(2), testKey.uppercase(), testKey + "00")) {
      assertThrows(IllegalArgumentException::class.java) {
        OrganizeDigests.hmacSha256Hex(bad, "journal.organize@1", "x")
      }
    }
  }
}
