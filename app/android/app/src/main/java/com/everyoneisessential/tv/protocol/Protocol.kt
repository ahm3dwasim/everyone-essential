package com.everyoneisessential.tv.protocol

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * A Kotlin port of `app/shared/protocol.ts` -- the same vocabulary, the same
 * decoders, refusing the same things for the same reasons, so the Stick's own
 * relay is not a redesign, just a second implementation of one spec. See the
 * TypeScript file for the design notes this only translates.
 *
 * Every decoder here is total, exactly as there: it returns either a decoded,
 * normalized [JSONObject] (unknown fields dropped, the same trims and bounds
 * applied) or the reason it refused. Nothing downstream ever sees a
 * half-parsed message.
 */
/**
 * Mirrors protocol.ts: the version both ends of the wire have to agree on
 * before anything is routed. Version 2 is the one where a hello may carry a
 * room's host credential and a welcome for a TV always answers with a fresh
 * one; a version-1 relay ignores that credential, so a component that speaks
 * an older version meets a refusal here rather than a silent fallback to the
 * weaker handshake.
 */
const val PROTOCOL_VERSION = 2
const val SCAN_MAX_OPTIONS = 4
const val SEAT_TOKEN_BYTES = 16

/**
 * How many bytes of randomness a room's host credential carries. Mirrors
 * protocol.ts: this is the credential a room's own TV keeps and presents when
 * it comes back to the room it made. Nothing about a room code is secret --
 * it is on the TV screen and in the join link -- so the code can never be what
 * makes a connection the TV. This can.
 */
const val HOST_TOKEN_BYTES = 32

val ROLE_IDS = listOf("A", "B", "C")
val CAPABILITIES = listOf("dpad", "scan", "voice")

/** Mirrors protocol.ts: 16 random bytes written out as lowercase hex, and nothing else. */
val SEAT_TOKEN_PATTERN = Regex("^[0-9a-f]{${SEAT_TOKEN_BYTES * 2}}$")

/** Mirrors protocol.ts: 32 random bytes written out as lowercase hex, and nothing else. */
val HOST_TOKEN_PATTERN = Regex("^[0-9a-f]{${HOST_TOKEN_BYTES * 2}}$")

/**
 * Mirrors protocol.ts: how long an emptied room is remembered before it is
 * forgotten. When the last peer leaves, the relay stops routing in the room
 * but keeps the code and the digest of the credential that was live, so the
 * room's own TV can come back to it and nobody else can make it again in the
 * meantime. The window only has to outlast a network blip -- a client comes
 * back on a backoff that caps at four seconds -- and it should not be much
 * longer, because for as long as it lasts the code is not a code a new room
 * can be given.
 */
const val ROOM_TOMBSTONE_MS = 60_000L

fun isRoleId(value: Any?): Boolean = value is String && ROLE_IDS.contains(value)
fun isCapability(value: Any?): Boolean = value is String && CAPABILITIES.contains(value)
fun isSeatToken(value: Any?): Boolean = value is String && SEAT_TOKEN_PATTERN.matches(value)
fun isHostToken(value: Any?): Boolean = value is String && HOST_TOKEN_PATTERN.matches(value)

sealed class Decoded<out T> {
    data class Ok<T>(val message: T) : Decoded<T>()
    data class Refused(val reason: String) : Decoded<Nothing>()
}

private fun <T> ok(message: T): Decoded<T> = Decoded.Ok(message)
private fun refuse(reason: String): Decoded<Nothing> = Decoded.Refused(reason)
private fun isRecord(value: Any?): Boolean = value is JSONObject

/**
 * client -> relay, decoded.
 *
 * `hostToken` is the credential the relay handed this connection when it made
 * the room it names. Only a TV ever has one, and only to come back to its own
 * room with it: a room code is public, so naming one is not a claim about who
 * you are.
 */
sealed class ClientToRelay {
    data class Hello(
        val v: Int,
        val kind: String,
        val room: String?,
        val hostToken: String?,
        val name: String?,
    ) : ClientToRelay()
    data class RelayRequest(val to: String, val payload: JSONObject) : ClientToRelay()
}

/** Client -> relay. The relay refuses anything that does not decode. */
fun decodeClientMessage(raw: String): Decoded<ClientToRelay> {
    val parsed: JSONObject
    try {
        val value = JSONTokener(raw).nextValue()
        if (value !is JSONObject) return refuse("not an object")
        parsed = value
    } catch (e: Exception) {
        return refuse("not JSON")
    }
    return when (val t = parsed.opt("t")) {
        "hello" -> {
            val kind = parsed.opt("kind")
            if (kind != "tv" && kind != "phone") return refuse("hello.kind")
            val v = parsed.opt("v").let { if (it is Number) it.toInt() else PROTOCOL_VERSION }
            val room = parsed.opt("room") as? String
            val name = parsed.opt("name") as? String
            // Dropped rather than refused when it is not the shape the relay
            // mints: the relay compares against what it issued, so a credential
            // that did not survive this line is a credential the hello does not
            // have -- refused as a stranger, which is where that ends up anyway.
            val hostToken = parsed.opt("hostToken").let { if (isHostToken(it)) it as String else null }
            ok(ClientToRelay.Hello(v, kind as String, room, hostToken, name))
        }
        "relay" -> {
            val to = parsed.opt("to")
            if (to != "tv" && to != "all" && to !is String) return refuse("relay.to")
            val decodedPayload = decodeGameMessage(parsed.opt("payload"))
            when (decodedPayload) {
                is Decoded.Refused -> refuse("relay.payload: ${decodedPayload.reason}")
                is Decoded.Ok -> ok(ClientToRelay.RelayRequest(to as String, decodedPayload.message))
            }
        }
        else -> refuse("unknown type $t")
    }
}

/* ------------------------------------------------------------------ */
/* Game layer (TV <-> phone)                                           */
/* ------------------------------------------------------------------ */

fun decodeGameMessage(value: Any?): Decoded<JSONObject> {
    if (!isRecord(value)) return refuse("not an object")
    val record = value as JSONObject
    return when (val t = record.opt("t")) {
        "join" -> {
            val out = JSONObject().put("t", "join")
            (record.opt("name") as? String)?.let { out.put("name", it.take(24)) }
            record.opt("want").let { if (isRoleId(it)) out.put("want", it) }
            // Mirrors protocol.ts: only the exact shape the phone mints -- 16 random
            // bytes as lowercase hex. A seat token is copied into the TV's markup, so
            // "any string up to 64 characters" is the wrong rule; anything else is
            // refused at the door.
            val seat = record.opt("seat")
            if (seat != null && seat != JSONObject.NULL && !isSeatToken(seat)) return refuse("join.seat")
            if (seat is String && isSeatToken(seat)) out.put("seat", seat)
            ok(out)
        }
        "assigned" -> {
            val role = record.opt("role")
            val out = JSONObject().put("t", "assigned").put("role", if (isRoleId(role)) role else JSONObject.NULL)
            (record.opt("reason") as? String)?.let { out.put("reason", it) }
            ok(out)
        }
        "view" -> when (val view = decodePhoneView(record.opt("view"))) {
            is Decoded.Refused -> refuse("view: ${view.reason}")
            is Decoded.Ok -> ok(JSONObject().put("t", "view").put("view", view.message))
        }
        "intent" -> when (val intent = decodeIntent(record.opt("intent"))) {
            is Decoded.Refused -> refuse("intent: ${intent.reason}")
            is Decoded.Ok -> ok(JSONObject().put("t", "intent").put("intent", intent.message))
        }
        "switch" -> {
            val role = record.opt("role")
            if (!isRoleId(role)) return refuse("switch.role")
            val phase = record.opt("phase")
            if (phase != "start" && phase != "ok" && phase != "refused") return refuse("switch.phase")
            val capabilities = decodeCapabilities(record.opt("capabilities")) ?: return refuse("switch.capabilities")
            val diff = decodeDiff(record.opt("diff")) ?: return refuse("switch.diff")
            val out = JSONObject()
                .put("t", "switch")
                .put("phase", phase)
                .put("role", role)
                .put("capabilities", JSONArray(capabilities))
                .put("diff", diff)
            (record.opt("reason") as? String)?.let { out.put("reason", it) }
            ok(out)
        }
        "superseded" -> ok(JSONObject().put("t", "superseded"))
        else -> refuse("unknown type $t")
    }
}

fun decodeIntent(value: Any?): Decoded<JSONObject> {
    if (!isRecord(value)) return refuse("not an object")
    val record = value as JSONObject
    return when (val k = record.opt("k")) {
        "choose" -> {
            val choiceId = record.opt("choiceId")
            if (choiceId !is String || choiceId.isEmpty()) return refuse("choose.choiceId")
            if (choiceId.length > 200) return refuse("choose.choiceId too long")
            ok(JSONObject().put("k", "choose").put("choiceId", choiceId))
        }
        "request_input_change" -> {
            val capabilities = decodeCapabilities(record.opt("capabilities"))
            if (capabilities == null || capabilities.isEmpty()) return refuse("request_input_change.capabilities")
            ok(JSONObject().put("k", "request_input_change").put("capabilities", JSONArray(capabilities)))
        }
        "choose_role" -> {
            val role = record.opt("role")
            if (!isRoleId(role)) return refuse("choose_role.role")
            ok(JSONObject().put("k", "choose_role").put("role", role))
        }
        "release_role" -> ok(JSONObject().put("k", "release_role"))
        "reclaim_seat" -> {
            // Mirrors protocol.ts: a non-blank name, trimmed to 24 characters. The TV
            // decides whether a held seat matches it; the relay only checks the shape.
            val name = record.opt("name")
            if (name !is String || name.trim().isEmpty()) return refuse("reclaim_seat.name")
            ok(JSONObject().put("k", "reclaim_seat").put("name", name.take(24)))
        }
        "release_claim" -> ok(JSONObject().put("k", "release_claim"))
        "continue_switch" -> ok(JSONObject().put("k", "continue_switch"))
        else -> refuse("unknown intent $k")
    }
}

private fun decodeCapabilities(value: Any?): List<String>? {
    if (value !is JSONArray) return null
    val out = mutableListOf<String>()
    for (i in 0 until value.length()) {
        val entry = value.opt(i)
        if (!isCapability(entry)) return null
        if (!out.contains(entry)) out.add(entry as String)
    }
    return out
}

private fun decodeDiff(value: Any?): JSONArray? {
    if (value !is JSONArray) return null
    val out = JSONArray()
    for (i in 0 until value.length()) {
        val entry = value.opt(i)
        if (entry !is JSONObject) return null
        val op = entry.opt("op")
        val summary = entry.opt("summary")
        if (op !is String || summary !is String) return null
        out.put(JSONObject().put("op", op).put("summary", summary))
    }
    return out
}

private fun decodePhoneView(value: Any?): Decoded<JSONObject> {
    if (!isRecord(value)) return refuse("not an object")
    val record = value as JSONObject
    val role = record.opt("role")
    val capabilities = decodeCapabilities(record.opt("capabilities")) ?: return refuse("capabilities")
    val clues = decodeClues(record.opt("clues")) ?: return refuse("clues")
    val choices = decodeChoices(record.opt("choices")) ?: return refuse("choices")
    // The 4-option bound is a property of the model, not a UI preference: a
    // phone that renders a 5-item scan list would be showing a choice the
    // validator says cannot be scanned. Refuse it at the door.
    if (choices.length() > SCAN_MAX_OPTIONS) return refuse("too many choices")
    val badgeValue = record.opt("badge")
    val badge: Any = when {
        badgeValue == null || badgeValue == JSONObject.NULL -> JSONObject.NULL
        badgeValue !is JSONObject -> return refuse("badge")
        else -> decodeBadge(badgeValue) ?: return refuse("badge")
    }
    val mode = record.opt("mode")
    if (mode != "waiting" && mode != "dpad" && mode != "voice" && mode != "scan") return refuse("mode")
    val choiceKind = record.opt("choiceKind")
    if (choiceKind != "none" && choiceKind != "action" && choiceKind != "option") return refuse("choiceKind")
    val takenRolesValue = record.opt("takenRoles")
    if (takenRolesValue != null && takenRolesValue != JSONObject.NULL && takenRolesValue !is JSONArray) {
        return refuse("takenRoles")
    }
    val takenRoles = JSONArray()
    if (takenRolesValue is JSONArray) {
        for (i in 0 until takenRolesValue.length()) {
            val entry = takenRolesValue.opt(i)
            if (isRoleId(entry)) takenRoles.put(entry)
        }
    }
    // Mirrors protocol.ts: the held seats (dropped, inside their grace window). A
    // missing list is nothing held, not a refusal; anything not a role id is dropped.
    val heldRolesValue = record.opt("heldRoles")
    val heldRoles = JSONArray()
    if (heldRolesValue is JSONArray) {
        for (i in 0 until heldRolesValue.length()) {
            val entry = heldRolesValue.opt(i)
            if (isRoleId(entry)) heldRoles.put(entry)
        }
    }
    // Mirrors protocol.ts: the roles the current mystery actually seats, a
    // subset of A/B/C. A missing list is no seats known, not a refusal.
    val seatRolesValue = record.opt("seatRoles")
    val seatRoles = JSONArray()
    if (seatRolesValue is JSONArray) {
        for (i in 0 until seatRolesValue.length()) {
            val entry = seatRolesValue.opt(i)
            if (isRoleId(entry)) seatRoles.put(entry)
        }
    }
    val out = JSONObject()
        .put("role", if (isRoleId(role)) role else JSONObject.NULL)
        .put("capabilities", JSONArray(capabilities))
        .put("mode", mode)
        .put("prompt", (record.opt("prompt") as? String) ?: "")
        .put("clues", clues)
        .put("choices", choices)
        .put("choiceKind", choiceKind)
        .put("badge", badge)
        .put("takenRoles", takenRoles)
        .put("heldRoles", heldRoles)
        .put("seatRoles", seatRoles)
        .put("canChangeInput", record.opt("canChangeInput") == true)
        .put("canChangeRole", record.opt("canChangeRole") == true)
        .put("claimingSeat", record.opt("claimingSeat") == true)
        // Mirrors protocol.ts: the role this phone's own browser is already
        // playing on another tab, or null. Dropping it would leave a second
        // tab on the Stick staring at a role picker every button of which the
        // TV refuses, with nothing on screen saying why.
        .put("otherTabRole", record.opt("otherTabRole").let { if (isRoleId(it)) it else JSONObject.NULL })
    (record.opt("notice") as? String)?.let { out.put("notice", it) }
    return ok(out)
}

private fun decodeClues(value: Any?): JSONArray? {
    if (value !is JSONArray) return null
    val out = JSONArray()
    for (i in 0 until value.length()) {
        val entry = value.opt(i)
        if (entry !is JSONObject) return null
        val id = entry.opt("id")
        val text = entry.opt("text")
        if (id !is String || text !is String) return null
        out.put(JSONObject().put("id", id).put("text", text))
    }
    return out
}

private fun decodeChoices(value: Any?): JSONArray? {
    if (value !is JSONArray) return null
    val out = JSONArray()
    for (i in 0 until value.length()) {
        val entry = value.opt(i)
        if (entry !is JSONObject) return null
        val id = entry.opt("id")
        val label = entry.opt("label")
        if (id !is String || label !is String) return null
        val choice = JSONObject().put("id", id).put("label", label)
        (entry.opt("hint") as? String)?.let { choice.put("hint", it) }
        out.put(choice)
    }
    return out
}

private fun decodeBadge(value: JSONObject): JSONObject? {
    val ok = value.opt("ok")
    val hash = value.opt("hash")
    if (ok !is Boolean || hash !is String) return null
    val linesValue = value.opt("lines")
    if (linesValue !is JSONArray) return null
    val lines = JSONArray()
    for (i in 0 until linesValue.length()) {
        val entry = linesValue.opt(i)
        if (entry !is JSONObject) return null
        val label = entry.opt("label")
        val entryOk = entry.opt("ok")
        if (label !is String || entryOk !is Boolean) return null
        lines.put(
            JSONObject()
                .put("label", label)
                .put("ok", entryOk)
                .put("detail", (entry.opt("detail") as? String) ?: ""),
        )
    }
    return JSONObject().put("ok", ok).put("hash", hash).put("lines", lines)
}

/* ------------------------------------------------------------------ */
/* Room codes -- a Kotlin port of app/shared/rooms.ts's generator       */
/* ------------------------------------------------------------------ */

const val ROOM_LENGTH = 4
private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** Uppercase, drop everything that is not a letter, and require exactly four. */
fun normalizeRoomCode(input: String): String? {
    val letters = input.uppercase().filter { it in 'A'..'Z' }
    return if (letters.length == ROOM_LENGTH) letters else null
}

/** A fresh code. `random` is injected so tests are deterministic. */
fun generateRoomCode(random: () -> Double = Math::random): String {
    val sb = StringBuilder()
    repeat(ROOM_LENGTH) {
        val index = (random() * ALPHABET.length).toInt().coerceIn(0, ALPHABET.length - 1)
        sb.append(ALPHABET[index])
    }
    return sb.toString()
}
