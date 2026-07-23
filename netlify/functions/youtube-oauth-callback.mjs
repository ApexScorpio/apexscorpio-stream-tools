import axios from "axios";
import { getStore } from "@netlify/blobs";
import { withLambda } from "@netlify/aws-lambda-compat";
import handlerModule from "./handlers/youtube-oauth-callback-handler.js";
import helpersModule from "./utils/oauth-helpers.js";

const { handler, setRuntimeAxios } = handlerModule;
const { setRuntimeGetStore } = helpersModule;

setRuntimeAxios(axios);
setRuntimeGetStore(getStore);

export default withLambda(handler);
