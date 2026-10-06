import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev, vercelOidc } from "eve/channels/auth";

const username = process.env.EVE_AUTH_USERNAME ?? "";
const password = process.env.EVE_AUTH_PASSWORD ?? "";

export default eveChannel({
  auth: [
    vercelOidc(),
    localDev(),
    httpBasic({ username, password }),
  ],
});
