from openai import OpenAI
import time
import json


API_KEY="sk-b6f835ff5f1611f1b6112ef21c8e63cd"

BASE_URL="https://new.sharedchat.cc/codex"

MODEL="gpt-5.5"


client=OpenAI(
    api_key=API_KEY,
    base_url=BASE_URL
)


print("="*60)
print("Codex Gateway Test")
print("="*60)



# 1. Responses API

print("\n[1] Responses API")

try:

    start=time.time()

    r=client.responses.create(
        model=MODEL,
        input="写一个Java Spring Boot Hello World"
    )

    print(
        "耗时:",
        round(time.time()-start,2)
    )


    print(
        r.output_text[:200]
    )


    print("✅ Responses API 正常")


except Exception as e:

    print("❌ Responses失败")
    print(e)



# 2. streaming

print("\n[2] Responses Stream")


try:

    count=0


    with client.responses.stream(
        model=MODEL,
        input="写100行Python测试代码"
    ) as stream:


        for event in stream:

            if event.type=="response.output_text.delta":

                count+=1


    print(
        "chunk:",
        count
    )


    if count>5:
        print("✅ Stream正常")
    else:
        print("⚠️ Stream异常")


except Exception as e:

    print("❌ Stream失败")
    print(e)




# 3. tool calling

print("\n[3] Tool Calling")


try:


    r=client.responses.create(

        model=MODEL,

        input="查询北京天气",

        tools=[
            {
            "type":"function",
            "name":"weather",
            "description":"天气查询",

            "parameters":
                {
                "type":"object",
                "properties":
                    {
                    "city":
                        {
                        "type":"string"
                        }
                    }
                }
            }
        ]
    )


    text=str(r)


    if "function_call" in text:

        print(
            "✅ Tool Calling支持"
        )

    else:

        print(
            "⚠️ 没检测到tool"
        )


except Exception as e:

    print("❌ Tool失败")
    print(e)




# 4. reasoning

print("\n[4] Reasoning")


try:


    r=client.responses.create(

        model=MODEL,

        input="证明1+1=2",

        reasoning={
            "effort":"high"
        }

    )


    print(
        json.dumps(
            r.model_dump(),
            ensure_ascii=False
        )[:1000]
    )


    print(
        "✅ reasoning请求成功"
    )


except Exception as e:

    print("❌ reasoning失败")
    print(e)