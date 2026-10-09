package com.everyoneisessential.tv.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A Kotlin port of `test/rooms.test.ts`'s room-code cases. */
class RoomsTest {
    @Test
    fun `normalizeRoomCode accepts a code typed in any case, with stray punctuation`() {
        assertEquals("ABCD", normalizeRoomCode("a b c d"))
        assertEquals("ABCD", normalizeRoomCode("ab-cd"))
    }

    @Test
    fun `normalizeRoomCode refuses anything that is not four letters`() {
        assertNull(normalizeRoomCode("ABCDE"))
        assertNull(normalizeRoomCode("ABC"))
        assertNull(normalizeRoomCode("AB1D"))
        assertNull(normalizeRoomCode(""))
    }

    @Test
    fun `generateRoomCode uses the injected randomness, so a test can predict it`() {
        assertEquals("AAAA", generateRoomCode { 0.0 })
        assertEquals("ZZZZ", generateRoomCode { 0.999999 })
    }

    @Test
    fun `generateRoomCode stays inside the alphabet even if the generator misbehaves`() {
        assertEquals("ZZZZ", generateRoomCode { 1.0 })
        assertEquals("AAAA", generateRoomCode { -5.0 })
    }
}
