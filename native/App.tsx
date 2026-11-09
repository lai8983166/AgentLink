import { mount, host } from "nsh";
import { HostProbe } from "./app/HostProbe";
import { ClientApp } from "./app/ClientApp";

mount(() => host.params.probe ? <HostProbe /> : <ClientApp />);
