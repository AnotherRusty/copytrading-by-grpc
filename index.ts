
import Client, {
    CommitmentLevel,
    SubscribeRequest,
    SubscribeUpdate,
    SubscribeUpdateTransaction,
} from "@triton-one/yellowstone-grpc";
import { CompiledInstruction } from "@triton-one/yellowstone-grpc/dist/grpc/solana-storage";
import { ClientDuplexStream } from '@grpc/grpc-js';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import fs from 'fs'
import { convertBuffers } from "./utils/geyser";
import { JUP_AGGREGATOR, USDC_MINT_ADDRESS } from "./constants";
import { getAssociatedTokenAddress, NATIVE_MINT } from "@solana/spl-token";
import { getBuyTxWithJupiter, getSellTxWithJupiter } from "./utils/swapOnlyAmm";
import { execute, getTokenMarketCap } from "./utils/legacy";
import { executeJitoTx } from "./utils/jito";

dotenv.config()

// Constants
const ENDPOINT = process.env.GRPC_ENDPOINT!;
const COMMITMENT = CommitmentLevel.PROCESSED;

const solanaConnection = new Connection(process.env.RPC_ENDPOINT!, 'confirmed');
const keyPair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));

const TARGET_ADDRESS = process.env.TARGET_ADDRESS!;
const IS_JITO = process.env.IS_JITO!;

if (!TARGET_ADDRESS) console.log('Target Address is not defined')

console.log('========================================= Your Config =======================================')
console.log('Target Wallet Address =====> ', TARGET_ADDRESS);
console.log("Bot Wallet Address    =====> ", keyPair.publicKey.toBase58());
console.log('=============================================================================================== \n');

// Main function
async function main(): Promise<void> {
    const client = new Client(ENDPOINT, undefined, {});
    const stream = await client.subscribe();
    const request = createSubscribeRequest();

    try {
        await sendSubscribeRequest(stream, request);
        console.log(`Geyser connection established - watching ${TARGET_ADDRESS} \n`);
        await handleStreamEvents(stream);
    } catch (error) {
        console.error('Error in subscription process:', error);
        stream.end();
    }
}

// Helper functions
function createSubscribeRequest(): SubscribeRequest {
    return {
        accounts: {},
        slots: {},
        transactions: {
            client: {
                accountInclude: [],
                accountExclude: [],
                accountRequired: [TARGET_ADDRESS],
                failed: false
            }
        },
        transactionsStatus: {},
        entry: {},
        blocks: {},
        blocksMeta: {},
        commitment: COMMITMENT,
        accountsDataSlice: [],
        ping: undefined,
    };
}

function sendSubscribeRequest(
    stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>,
    request: SubscribeRequest
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        stream.write(request, (err: Error | null) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

function handleStreamEvents(stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        stream.on('data', async (data) => {
            await handleData(data, stream)
        });
        stream.on("error", (error: Error) => {
            console.error('Stream error:', error);
            reject(error);
            stream.end();
        });
        stream.on("end", () => {
            console.log('Stream ended');
            resolve();
        });
        stream.on("close", () => {
            console.log('Stream closed');
            resolve();
        });
    });
}

async function handleData(data: SubscribeUpdate, stream: ClientDuplexStream<SubscribeRequest, SubscribeUpdate>) {
    try {
        if (!isSubscribeUpdateTransaction(data)) {
            return;
        }

        const convertedTx = convertBuffers(data.transaction);
        if (!JSON.stringify(convertedTx).includes(JUP_AGGREGATOR)) {
            console.log("Not a Jupiter swap");
            return;
        }
        const transaction = data.transaction?.transaction;
        const message = transaction?.transaction?.message;

        if (!transaction || !message) {
            return;
        }

        const tokenAmount = getBalanceChange(data, "");
        const usdcAmount = getBalanceChange(data, "usdc");
        if (tokenAmount && usdcAmount) {
            const isBuy: boolean = tokenAmount > 0;

            const mint = getMintAccount(data);

            if (!mint) return;

            if (mint == NATIVE_MINT.toBase58()) return;

            const formattedSignature = convertSignature(transaction.signature);
            console.log('========================================= Target Wallet =======================================');
            console.log("Signature => ", `https://solscan.io/tx/${formattedSignature.base58}`);
            isBuy ? console.log("Detail => ", `buy ${tokenAmount} of ${mint} token with ${-usdcAmount} usdc`) : console.log("Detail => ", `sell ${-tokenAmount} of ${mint} token with ${usdcAmount} usdc`);
            console.log('=============================================================================================== \n');

            const decimals = getTokenDecimals(data);
            if (!decimals) return;
            let swapTx;
            if (isBuy) {
                const solBalance = await solanaConnection.getBalance(keyPair.publicKey);
                const remainingSolBalance = 0.01 * LAMPORTS_PER_SOL;
                if (solBalance < remainingSolBalance) {
                    console.log("Insufficient sol balance.")
                    return;
                }
                const tokenIntAmount = Math.floor(tokenAmount);
                let amount;
                if (tokenIntAmount < 10 ** 4) amount = tokenIntAmount;
                else if (tokenIntAmount < 30 * 10 ** 3) amount = 10 ** 4;
                else if (tokenIntAmount < 10 ** 5) amount = 30 * 10 ** 3;
                else amount = 10 ** 5;
                const tokenMC = Math.floor(await getTokenMarketCap(mint));
                // console.log("🚀 ~ handleData ~ tokenMC:", tokenMC)
                if (tokenMC < 30 * 10 ** 6) { }
                else if (tokenMC < 10 ** 8) amount *= 0.7;
                else amount *= 0.5;
                swapTx = await getBuyTxWithJupiter(
                    keyPair,
                    new PublicKey(mint),
                    Math.floor(amount) * (10 ** decimals) / 10000
                );
                if (swapTx == null) {
                    // console.log(`Error getting swap transaction`)
                    return;
                }
                let txSig;
                if (IS_JITO == "true") txSig = await executeJitoTx([swapTx], keyPair, "confirmed");
                else txSig = await execute(solanaConnection, swapTx);
                const tokenTx = txSig ? `https://solscan.io/tx/${txSig}` : '';
                console.log('========================================= Bot Wallet =======================================');
                console.log("Bought Token: ", tokenTx);
                console.log('=============================================================================================== \n');

            } else {
                const tokenIntAmount = Math.floor(-tokenAmount);
                const mainWalletBaseAta = await getAssociatedTokenAddress(new PublicKey(mint), keyPair.publicKey);
                const targetWalletBaseAta = await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(TARGET_ADDRESS));
                const mainWalletTokenAmount = (await solanaConnection.getTokenAccountBalance(mainWalletBaseAta)).value
                // console.log("🚀 ~ handleData ~ mainWalletTokenAmount:", mainWalletTokenAmount)
                const targetWalletTokenAmount = (await solanaConnection.getTokenAccountBalance(targetWalletBaseAta)).value
                // console.log("🚀 ~ handleData ~ targetWalletTokenAmount:", targetWalletTokenAmount)

                const sellAmount = tokenIntAmount / (Number(targetWalletTokenAmount.uiAmount) + tokenIntAmount) * Number(mainWalletTokenAmount.uiAmount) * (10 ** decimals);
                // console.log("🚀 ~ handleData ~ sellAmount:", sellAmount)
                if (sellAmount == 0) return;
                swapTx = await getSellTxWithJupiter(
                    keyPair,
                    new PublicKey(mint),
                    Math.floor(sellAmount)
                );
                if (swapTx == null) {
                    // console.log(`Error getting swap transaction`)
                    return;
                }
                let txSig;
                if (IS_JITO == "true") {
                    txSig = await executeJitoTx([swapTx], keyPair, "confirmed");
                } else {
                    txSig = await execute(solanaConnection, swapTx);
                }
                if (!txSig) return;
                const tokenTx = `https://solscan.io/tx/${txSig}`;
                console.log('========================================= Bot Wallet =======================================');
                console.log("Sold Token: ", tokenTx);
                console.log('=============================================================================================== \n');
            }
            return true;
        }
    } catch (error) {
        // console.log(error);
    }
}

// Check token balance change of target wallet
const filterAccount = (accounts: any[], token: string): any | null => {
    return accounts?.find((account) => {
        if (token === "") {
            return account.owner === TARGET_ADDRESS && account.mint !== USDC_MINT_ADDRESS;
        } else if (token === "usdc") {
            return account.owner === TARGET_ADDRESS && account.mint === USDC_MINT_ADDRESS;
        }
        return false;
    }) || null;
}

const getBalanceChange = (data: SubscribeUpdate, token: string): number | null => {
    const preAccounts = data.transaction?.transaction?.meta?.preTokenBalances;
    const postAccounts = data.transaction?.transaction?.meta?.postTokenBalances;
    if (preAccounts == undefined || postAccounts == undefined) return null;

    const preAccount = filterAccount(preAccounts, token);
    const postAccount = filterAccount(postAccounts, token);
    if (!preAccount && !postAccount) return null;

    const preBalance = preAccount ? preAccount.uiTokenAmount?.uiAmount : 0;
    const postBalance = postAccount ? postAccount.uiTokenAmount?.uiAmount : 0;

    return postBalance - preBalance
}

// Get Token mint
const getMintAccount = (data: SubscribeUpdate): string | null => {
    const preAccounts = data.transaction?.transaction?.meta?.preTokenBalances;
    if (preAccounts == undefined) return null;
    const preAccount = filterAccount(preAccounts, "");
    if (preAccount) return preAccount.mint;
    else return null;
}

const getTokenDecimals = (data: SubscribeUpdate): number | null => {
    const preAccounts = data.transaction?.transaction?.meta?.preTokenBalances;
    if (preAccounts == undefined) return null;
    const preAccount = filterAccount(preAccounts, "");
    if (preAccount) return preAccount.uiTokenAmount.decimals;
    else return null;
}

function isSubscribeUpdateTransaction(data: SubscribeUpdate): data is SubscribeUpdate & { transaction: SubscribeUpdateTransaction } {
    return (
        'transaction' in data &&
        typeof data.transaction === 'object' &&
        data.transaction !== null &&
        'slot' in data.transaction &&
        'transaction' in data.transaction
    );
}

function convertSignature(signature: Uint8Array): { base58: string } {
    return { base58: bs58.encode(Buffer.from(signature)) };
}

main().catch((err) => {
    console.error('Unhandled error in main:', err);
    process.exit(1);
});


// const init = async () => {
//     const mint = new PublicKey('A7n12WzYXZdzEpLaxxRGqjRi88JdcQmRYokmPTjNXs3q');
//     const amount = 811
//     await sellToken(mint, solanaConnection, keypair, amount, 1)
// }

// init()