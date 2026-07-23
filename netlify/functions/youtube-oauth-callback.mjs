import { withLambda } from "@netlify/aws-lambda-compat";
import handlerModule from "./handlers/youtube-oauth-callback-handler.js";

const { handler } = handlerModule;

export default withLambda(handler);
