// The entry: it registers one class by a call and one as a module's provider.

import { Container, Module } from "@example/container";
import { Clock, Mailer, Plain, Reporter } from "./services.ts";

new Container().bind(Mailer);

@Module({ providers: [Clock] })
export class AppModule {}

export const unregistered = [Reporter, Plain];
