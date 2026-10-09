package com.everyoneisessential.tv.protocol

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A Kotlin port of the representative cases in `test/protocol.test.ts`: the
 * decoders are total, and the trust boundary holds -- a phone cannot forge an
 * action it was not offered.
 */
class ProtocolTest {
    @Test
    fun `round-trips a hello, with the version filled in`() {
        val decoded = decodeClientMessage(JSONObject().put("t", "hello").put("v", PROTOCOL_VERSION).put("kind", "phone").put("room", "ABCD").toString())
        assertTrue(decoded is Decoded.Ok)
        val hello = (decoded as Decoded.Ok).message as ClientToRelay.Hello
        assertEquals(PROTOCOL_VERSION, hello.v)
        assertEquals("phone", hello.kind)
        assertEquals("ABCD", hello.room)
    }

    @Test
    fun `gives a hello with no version the current one rather than refusing it`() {
        val decoded = decodeClientMessage(JSONObject().put("t", "hello").put("kind", "tv").toString())
        val hello = (decoded as Decoded.Ok).message as ClientToRelay.Hello
        assertEquals(PROTOCOL_VERSION, hello.v)
    }

    @Test
    fun `refuses a hello that does not say whether it is a TV or a phone`() {
        val decoded = decodeClientMessage(JSONObject().put("t", "hello").put("kind", "tablet").toString())
        assertEquals("hello.kind", (decoded as Decoded.Refused).reason)
    }

    @Test
    fun `carries a room's host credential through a hello, and drops anything that is not one`() {
        // 32 random bytes as lowercase hex is the only thing the relay mints,
        // so it is the only thing a hello may carry. Anything else is dropped
        // here and the relay then sees no credential at all and refuses the
        // claim -- fail-closed, and never a comparison against input of a
        // length an attacker chose.
        val token = "c".repeat(64)
        val good = decodeClientMessage(
            JSONObject().put("t", "hello").put("kind", "tv").put("room", "ABCD").put("hostToken", token).toString(),
        )
        assertEquals(token, ((good as Decoded.Ok).message as ClientToRelay.Hello).hostToken)

        for (bad in listOf("not-a-credential", token.uppercase(), token.dropLast(1), token + "a", "")) {
            val decoded = decodeClientMessage(
                JSONObject().put("t", "hello").put("kind", "tv").put("room", "ABCD").put("hostToken", bad).toString(),
            )
            assertEquals(null, ((decoded as Decoded.Ok).message as ClientToRelay.Hello).hostToken)
        }

        // A hello with none at all is every phone and every new TV.
        val absent = decodeClientMessage(JSONObject().put("t", "hello").put("kind", "tv").toString())
        assertEquals(null, ((absent as Decoded.Ok).message as ClientToRelay.Hello).hostToken)
    }

    @Test
    fun `drops a client-supplied from -- only the relay says who sent a frame`() {
        val raw = JSONObject().put("t", "relay").put("from", "p1-someone-else").put("to", "tv").put("payload", JSONObject().put("t", "join"))
        val decoded = decodeClientMessage(raw.toString())
        val request = (decoded as Decoded.Ok).message as ClientToRelay.RelayRequest
        assertEquals("tv", request.to)
        assertEquals("join", request.payload.getString("t"))
    }

    @Test
    fun `refuses junk, non-objects, and unknown types`() {
        assertEquals("not JSON", (decodeClientMessage("{not json") as Decoded.Refused).reason)
        assertEquals("not an object", (decodeClientMessage("[]") as Decoded.Refused).reason)
        assertEquals("unknown type shout", (decodeClientMessage(JSONObject().put("t", "shout").toString()) as Decoded.Refused).reason)
    }

    @Test
    fun `refuses a relay frame whose payload is not a game message`() {
        val raw = JSONObject().put("t", "relay").put("to", "tv").put("payload", JSONObject().put("t", "nope"))
        assertEquals("relay.payload: unknown type nope", (decodeClientMessage(raw.toString()) as Decoded.Refused).reason)
    }

    @Test
    fun `accepts a choice id and refuses an empty or oversized one`() {
        assertTrue(decodeIntent(JSONObject().put("k", "choose").put("choiceId", "opt:2")) is Decoded.Ok)
        assertEquals("choose.choiceId", (decodeIntent(JSONObject().put("k", "choose").put("choiceId", "")) as Decoded.Refused).reason)
        assertEquals(
            "choose.choiceId too long",
            (decodeIntent(JSONObject().put("k", "choose").put("choiceId", "x".repeat(201))) as Decoded.Refused).reason,
        )
    }

    @Test
    fun `de-duplicates a capability request and refuses an empty or unknown one`() {
        val decoded = decodeIntent(JSONObject().put("k", "request_input_change").put("capabilities", listOf("scan", "scan")))
        val capabilities = (decoded as Decoded.Ok).message.getJSONArray("capabilities")
        assertEquals(1, capabilities.length())
        assertEquals("scan", capabilities.getString(0))
        assertTrue(decodeIntent(JSONObject().put("k", "request_input_change").put("capabilities", emptyList<String>())) is Decoded.Refused)
        assertTrue(decodeIntent(JSONObject().put("k", "request_input_change").put("capabilities", listOf("scan", "smell"))) is Decoded.Refused)
    }

    @Test
    fun `will not let a phone choose a role the puzzle does not have`() {
        assertEquals("choose_role.role", (decodeIntent(JSONObject().put("k", "choose_role").put("role", "Z")) as Decoded.Refused).reason)
    }

    @Test
    fun `lets the changed player's own phone continue past a switch`() {
        // The rebuild moment's Continue is a valid intent from the phone whose
        // controls are changing: accepting it is what lets that player dismiss the
        // moment on the Stick, not just the TV.
        val decoded = decodeIntent(JSONObject().put("k", "continue_switch"))
        assertTrue(decoded is Decoded.Ok)
        assertEquals("continue_switch", (decoded as Decoded.Ok).message.getString("k"))
    }

    @Test
    fun `lets a returning player reclaim a held seat by name, trimmed to 24 characters`() {
        val decoded = decodeIntent(JSONObject().put("k", "reclaim_seat").put("name", "A".repeat(40)))
        assertTrue(decoded is Decoded.Ok)
        assertEquals("A".repeat(24), (decoded as Decoded.Ok).message.getString("name"))
        assertEquals("reclaim_seat.name", (decodeIntent(JSONObject().put("k", "reclaim_seat").put("name", "  ")) as Decoded.Refused).reason)
        assertEquals("reclaim_seat.name", (decodeIntent(JSONObject().put("k", "reclaim_seat")) as Decoded.Refused).reason)
    }

    @Test
    fun `has no way to say I performed this action`() {
        // The whole trust model in one assertion: a phone picks from what it was
        // shown, and the TV decides what the pick means.
        val forged = decodeIntent(JSONObject().put("k", "perform").put("actionId", "any_enter_study"))
        assertTrue(forged is Decoded.Refused)
    }

    @Test
    fun `refuses a phone view with more choices than the model can scan`() {
        val view = phoneViewFixture(5)
        val decoded = decodeGameMessage(JSONObject().put("t", "view").put("view", view))
        assertEquals("view: too many choices", (decoded as Decoded.Refused).reason)
    }

    @Test
    fun `accepts a phone view at the bound and strips what it cannot vouch for`() {
        val view = phoneViewFixture(4).put("canChangeInput", "yes")
        val decoded = decodeGameMessage(JSONObject().put("t", "view").put("view", view))
        val decodedView = (decoded as Decoded.Ok).message.getJSONObject("view")
        assertEquals(4, decodedView.getJSONArray("choices").length())
        assertEquals(false, decodedView.getBoolean("canChangeInput"))
    }

    @Test
    fun `refuses a switch whose diff is not a list of lines`() {
        val decoded = decodeGameMessage(
            JSONObject()
                .put("t", "switch")
                .put("phase", "start")
                .put("role", "C")
                .put("capabilities", listOf("scan"))
                .put("diff", listOf(JSONObject().put("op", "capability_change"))),
        )
        assertEquals("switch.diff", (decoded as Decoded.Refused).reason)
    }

    @Test
    fun `keeps a phone view's held seats, so a returning phone can be offered its seat back`() {
        val raw = JSONObject().put("t", "view").put("view", phoneViewFixture(1).put("heldRoles", listOf("B", "Z")))
        val decoded = decodeGameMessage(raw)
        assertTrue(decoded is Decoded.Ok)
        val held = (decoded as Decoded.Ok).message.getJSONObject("view").getJSONArray("heldRoles")
        assertEquals(1, held.length())
        assertEquals("B", held.getString(0))
        val none = (decodeGameMessage(JSONObject().put("t", "view").put("view", phoneViewFixture(1))) as Decoded.Ok)
        assertEquals(0, none.message.getJSONObject("view").getJSONArray("heldRoles").length())
    }

    private fun phoneViewFixture(choiceCount: Int): JSONObject {
        val choices = org.json.JSONArray()
        repeat(choiceCount) { i -> choices.put(JSONObject().put("id", "act:x$i").put("label", "x$i")) }
        return JSONObject()
            .put("role", "C")
            .put("capabilities", listOf("scan"))
            .put("mode", "scan")
            .put("prompt", "Your move")
            .put("clues", listOf(JSONObject().put("id", "desk_drawer_note").put("text", "note")))
            .put("choices", choices)
            .put("choiceKind", "action")
            .put("badge", JSONObject.NULL)
            .put("takenRoles", listOf("A", "B"))
            .put("canChangeInput", true)
            .put("canChangeRole", true)
    }
}
