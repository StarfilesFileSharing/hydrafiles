# Hydrafiles
The headless storage network.

[Skip To Deploy Instructions](#how-do-i-setup-a-node)

## What is Hydrafiles?
Hydrafiles is the headless storage network. Anyone can be a part of the network. Hydrafiles allows for files to be hosted in the Hydra cloud, where no one knows what's hosted where.

## Why Hydrafiles?
In a world where information is freedom. We believe that the people have a right to access the world's information. We believe the people of Russia, China, Iran, America, North Korea, and the rest of the world, all deserve access to the same information. Most people don't use anti-censorship tools when they're inconvenient. We can't control the people. I personally wish the whole internet ran on I2P. But that's never going to happen because it's slow and inconvenient for users. Torrents died off because streaming is more convenient. Piracy is back because subscriptions have gotten inconvenient. Hydrafiles realises that the people don't want to trade their convenience for freedom. Unfortunately, not all hosts have the luxury. With global censorship of whistleblowing and propaganda at an all time high, it is, now more than ever, crucial for people to be able to anonymously serve files to the masses.

## How does it work?
![I'm Spartacus!](i-am-spartacus.gif)

TLDR: This scene ^

When someone tries to download a file, nodes with the file will serve it directly. Nodes without the file will then ask other nodes for the file, once they find another node with a file, they will respond to all requests saying they have it, each of them forwarding it on, saying they have it, etc. until the original node is reached, with a message from all nodes they connected to, saying they have it. If no one has it, all nodes will end up giving a no response, telling the user that it isn't hosted anywhere. This design allows for better than TOR level security, for serving static files via HTTP. A core improvement over TOR is that all hosts and relays look identical, which they don't when using TOR.

## What Hydrafiles isn't.
The Hydrafiles network does NOT provide privacy to the end user. The node you initially connected to, can see exactly what you're doing. If you need to download files discretely, use TOR when accessing Hydrafiles. Hydrafiles itself does not protect files. All data on the Hydrafiles network can be seen by all nodes. Sensitive files MUST be encrypted before submission to the network.

## Who's in charge of Hydrafiles?
No one, anyone, everyone. Hydrafiles doesn't have a head. It's simply an API specification. Anyone can setup a domain, server, or S3 bucket, and add it to the network. The more people that decide to do this, the stronger the network.

## How can I tell where a file is being hosted?
You can't. If a server in the network is hosting a file, it will look like everyone is hosting that file.

## How can I take a file off of Hydrafiles?
You can contact the site that is hosting your file.

## How does Hydrafiles obscure where a file is being hosted?
When you call a Hydrafiles site, if it's not hosting the requested file, it will check with other Hydrafiles sites and pull the file from them. This means no matter what Hydrafiles API you call, as long as one Hydrafiles site is serving a file, they all are.

## Where is Hydrafiles?
Hydrafiles is everywhere. With the goal of being cross-border, we ask people like you to contribute to the movement, by setting up cross-border domains and servers.


## How do I setup a node?
```
git clone https://github.com/StarfilesFileSharing/Hydrafiles
cd Hydrafiles
yarn
node index.js
```

### Configuration
At the top of `index.js`, there are 2 sections. "Confiuration" and "Advanced Configuration".

### Serving files
Move your file to the `files/` dir (creaetd on first run), and change the filename to the SHA256 checksum of the file.