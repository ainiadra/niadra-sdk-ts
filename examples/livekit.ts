// A LiveKit voice agent that answers the phone with the caller's context already in the prompt.
//   NIADRA_API_KEY=... LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... node livekit.js dev
import { type JobContext, ServerOptions, cli, defineAgent, voice } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { Niadra } from "@niadra/sdk";
import { NiadraAgent, NiadraMemory, attestationProof, sipConversationId, sipSubject } from "@niadra/sdk/livekit";

const niadra = new Niadra();

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const caller = await ctx.waitForParticipant();
    const conversation = niadra.conversation({
      subject: sipSubject(caller),
      channel: "voice",
      conversation_id: sipConversationId(caller, ctx.room.name ?? "room"),
    });
    const memory = new NiadraMemory({
      conversation,
      // Map the carrier's STIR/SHAKEN header to this attribute in your SIP trunk's header settings.
      verify: attestationProof(caller.attributes["sip.h.x-stir-verstat"]),
    });
    const session = new voice.AgentSession({
      stt: "deepgram/nova-3",
      llm: "openai/gpt-4.1-mini",
      tts: "cartesia/sonic-3",
    });
    memory.attach(session);
    await session.start({
      agent: new NiadraAgent({ instructions: "You answer the phone for Acme Energy. Be brief.", memory }),
      room: ctx.room,
    });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
}
